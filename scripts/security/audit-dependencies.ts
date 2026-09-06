import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

export type AdvisorySeverity = 'info' | 'low' | 'moderate' | 'high' | 'critical';
export type AdvisoryDisposition = 'ACCEPT' | 'MITIGATE' | 'FIX' | 'NOT_AFFECTED';

export interface AdvisoryTriage {
  readonly advisoryId: string;
  readonly package: string;
  readonly installedVersion: string;
  readonly affectedRange: string;
  readonly fixedVersion: string;
  readonly dependencyType: NormalizedAdvisory['dependencyType'];
  readonly severity: AdvisorySeverity;
  readonly source: string;
  readonly disposition: AdvisoryDisposition;
  readonly justification: string;
  readonly owner: string;
  readonly reviewer: string;
  readonly decidedOn: string;
  readonly reviewBy: string;
}

export interface NormalizedAdvisory {
  readonly advisoryId: string;
  readonly package: string;
  readonly installedVersion: string;
  readonly affectedRange: string;
  readonly fixedVersion: string | null;
  readonly dependencyType: 'production' | 'development' | 'optional' | 'transitive';
  readonly direct: boolean;
  readonly severity: AdvisorySeverity;
  readonly source: string;
  readonly title: string;
  readonly triage: AdvisoryTriage | null;
}

type AuditObject = Readonly<Record<string, unknown>>;

interface EvaluationOptions {
  readonly dependencyTypes?: ReadonlyMap<string, NormalizedAdvisory['dependencyType']>;
  readonly installedVersions?: ReadonlyMap<string, readonly string[]>;
  readonly now?: Date;
}

export interface DependencyAuditReport {
  readonly schemaVersion: 1;
  readonly event: 'security.dependencies.audited';
  readonly generatedAt: string;
  readonly source: 'pnpm-audit/npm-registry';
  readonly passed: boolean;
  readonly summary: Readonly<Record<AdvisorySeverity | 'total', number>>;
  readonly advisories: readonly NormalizedAdvisory[];
  readonly policyViolations: readonly string[];
}

function object(value: unknown): AuditObject | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as AuditObject)
    : undefined;
}

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function severity(value: unknown): AdvisorySeverity {
  return ['info', 'low', 'moderate', 'high', 'critical'].includes(String(value))
    ? (value as AdvisorySeverity)
    : 'info';
}

function advisoryId(record: AuditObject): string {
  const url = text(record.url);
  const ghsa = /\/advisories\/(GHSA-[A-Za-z0-9-]+)/u.exec(url)?.[1];
  return ghsa ?? text(record.id, String(record.source ?? 'unknown'));
}

function fixedVersion(value: unknown): string | null {
  if (typeof value === 'string') return value || null;
  const record = object(value);
  return record ? text(record.version) || null : null;
}

function installedVersion(
  packageName: string,
  versions: ReadonlyMap<string, readonly string[]> | undefined,
): string {
  const values = versions?.get(packageName) ?? [];
  return values.length > 0 ? [...values].sort().join(', ') : 'unknown';
}

function normalizeV2(
  raw: AuditObject,
  triage: readonly AdvisoryTriage[],
  options: EvaluationOptions,
): readonly NormalizedAdvisory[] {
  const vulnerabilities = object(raw.vulnerabilities);
  if (!vulnerabilities) return [];
  const normalized: NormalizedAdvisory[] = [];

  for (const [vulnerabilityName, value] of Object.entries(vulnerabilities)) {
    const vulnerability = object(value);
    if (!vulnerability) continue;
    const via = Array.isArray(vulnerability.via) ? vulnerability.via : [];
    const advisoryRecords = via.map(object).filter((item): item is AuditObject => Boolean(item));
    for (const advisory of advisoryRecords) {
      const packageName = text(advisory.name, text(advisory.dependency, vulnerabilityName));
      const id = advisoryId(advisory);
      normalized.push({
        advisoryId: id,
        package: packageName,
        installedVersion: installedVersion(packageName, options.installedVersions),
        affectedRange: text(advisory.range, text(vulnerability.range, 'unknown')),
        fixedVersion: fixedVersion(vulnerability.fixAvailable),
        dependencyType: options.dependencyTypes?.get(packageName) ?? 'transitive',
        direct: vulnerability.isDirect === true,
        severity: severity(advisory.severity ?? vulnerability.severity),
        source: text(advisory.url, 'npm-registry'),
        title: text(advisory.title, 'Untitled advisory'),
        triage:
          triage.find(
            (decision) => decision.advisoryId === id && decision.package === packageName,
          ) ?? null,
      });
    }
  }
  return normalized;
}

function normalizeV1(
  raw: AuditObject,
  triage: readonly AdvisoryTriage[],
  options: EvaluationOptions,
): readonly NormalizedAdvisory[] {
  const advisories = object(raw.advisories);
  if (!advisories) return [];
  return Object.values(advisories).flatMap((value) => {
    const advisory = object(value);
    if (!advisory) return [];
    const packageName = text(advisory.module_name, text(advisory.name, 'unknown'));
    const id = advisoryId(advisory);
    const finding = Array.isArray(advisory.findings) ? object(advisory.findings[0]) : undefined;
    const paths = finding && Array.isArray(finding.paths) ? finding.paths : [];
    const findingVersion = text(finding?.version);
    const versions = findingVersion ? [findingVersion] : [];
    return [
      {
        advisoryId: id,
        package: packageName,
        installedVersion:
          versions.length > 0
            ? [...new Set(versions)].sort().join(', ')
            : installedVersion(packageName, options.installedVersions),
        affectedRange: text(advisory.vulnerable_versions, 'unknown'),
        fixedVersion: text(advisory.patched_versions) || null,
        dependencyType: options.dependencyTypes?.get(packageName) ?? 'transitive',
        direct:
          advisory.direct === true ||
          paths.some((path) => typeof path === 'string' && path.split('>').length === 2),
        severity: severity(advisory.severity),
        source: text(advisory.url, 'npm-registry'),
        title: text(advisory.title, 'Untitled advisory'),
        triage:
          triage.find(
            (decision) => decision.advisoryId === id && decision.package === packageName,
          ) ?? null,
      },
    ];
  });
}

function validTriage(decision: AdvisoryTriage, now: Date): boolean {
  const decidedOn = Date.parse(`${decision.decidedOn}T00:00:00Z`);
  const reviewBy = Date.parse(`${decision.reviewBy}T23:59:59Z`);
  return (
    Object.values(decision).every(
      (value) => typeof value === 'string' && value.trim().length > 0,
    ) &&
    Number.isFinite(decidedOn) &&
    Number.isFinite(reviewBy) &&
    reviewBy >= decidedOn &&
    reviewBy >= now.getTime()
  );
}

export function evaluateDependencyAudit(
  rawValue: unknown,
  triage: readonly AdvisoryTriage[],
  options: EvaluationOptions = {},
): DependencyAuditReport {
  const raw = object(rawValue);
  if (!raw || object(raw.error)) throw new Error('Dependency audit did not return a valid report');
  const advisories = [
    ...normalizeV2(raw, triage, options),
    ...normalizeV1(raw, triage, options),
  ].sort((left, right) =>
    `${left.severity}:${left.package}:${left.advisoryId}`.localeCompare(
      `${right.severity}:${right.package}:${right.advisoryId}`,
    ),
  );
  const policyViolations: string[] = [];
  const now = options.now ?? new Date();
  for (const advisory of advisories) {
    if (advisory.severity === 'high' || advisory.severity === 'critical') {
      policyViolations.push(`${advisory.advisoryId}: ${advisory.severity} severity is blocked`);
    }
    if (
      advisory.severity === 'moderate' &&
      (!advisory.triage || !validTriage(advisory.triage, now))
    ) {
      policyViolations.push(`${advisory.advisoryId}: moderate advisory requires current triage`);
    }
  }
  const summary = { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 };
  for (const advisory of advisories) {
    summary[advisory.severity] += 1;
    summary.total += 1;
  }
  return {
    schemaVersion: 1,
    event: 'security.dependencies.audited',
    generatedAt: now.toISOString(),
    source: 'pnpm-audit/npm-registry',
    passed: policyViolations.length === 0,
    summary,
    advisories,
    policyViolations,
  };
}

async function directDependencyTypes(
  root: string,
): Promise<ReadonlyMap<string, NormalizedAdvisory['dependencyType']>> {
  const manifests = ['package.json'];
  for (const group of ['apps', 'packages']) {
    const { readdir } = await import('node:fs/promises');
    for (const entry of await readdir(resolve(root, group), { withFileTypes: true })) {
      if (entry.isDirectory()) manifests.push(`${group}/${entry.name}/package.json`);
    }
  }
  const types = new Map<string, NormalizedAdvisory['dependencyType']>();
  for (const manifest of manifests) {
    const parsed = JSON.parse(await readFile(resolve(root, manifest), 'utf8')) as AuditObject;
    for (const [field, type] of [
      ['dependencies', 'production'],
      ['optionalDependencies', 'optional'],
      ['devDependencies', 'development'],
    ] as const) {
      for (const name of Object.keys(object(parsed[field]) ?? {})) {
        if (!types.has(name) || type === 'production') types.set(name, type);
      }
    }
  }
  return types;
}

async function installedVersions(root: string): Promise<ReadonlyMap<string, readonly string[]>> {
  const { readdir } = await import('node:fs/promises');
  const versions = new Map<string, Set<string>>();
  for (const entry of await readdir(resolve(root, 'node_modules/.pnpm'), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const modules = resolve(root, 'node_modules/.pnpm', entry.name, 'node_modules');
    let packageEntries;
    try {
      packageEntries = await readdir(modules, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const packageEntry of packageEntries) {
      const candidates = packageEntry.name.startsWith('@')
        ? (await readdir(resolve(modules, packageEntry.name), { withFileTypes: true })).map(
            (child) => `${packageEntry.name}/${child.name}`,
          )
        : [packageEntry.name];
      for (const candidate of candidates) {
        try {
          const metadata = JSON.parse(
            await readFile(resolve(modules, candidate, 'package.json'), 'utf8'),
          ) as AuditObject;
          const name = text(metadata.name);
          const version = text(metadata.version);
          if (name && version) {
            const values = versions.get(name) ?? new Set<string>();
            values.add(version);
            versions.set(name, values);
          }
        } catch {
          // Non-package directories do not contribute to the installed inventory.
        }
      }
    }
  }
  return new Map([...versions].map(([name, values]) => [name, [...values].sort()]));
}

async function runAudit(root: string): Promise<unknown> {
  return await new Promise((fulfill, reject) => {
    const child = spawn(
      process.execPath,
      [resolve(root, 'node_modules/pnpm/bin/pnpm.cjs'), 'audit', '--json'],
      {
        cwd: root,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
    child.on('error', reject);
    child.on('close', () => {
      try {
        fulfill(JSON.parse(stdout));
      } catch {
        reject(
          new Error(`Dependency audit failed without JSON: ${stderr.trim() || 'unknown error'}`),
        );
      }
    });
  });
}

async function main(): Promise<void> {
  const root = process.cwd();
  const outputIndex = process.argv.indexOf('--output');
  const output = outputIndex >= 0 ? process.argv[outputIndex + 1] : undefined;
  const triageFile = resolve(root, 'docs/security/dependency-advisory-triage.json');
  const triageDocument = JSON.parse(await readFile(triageFile, 'utf8')) as AuditObject;
  const decisions = Array.isArray(triageDocument.decisions)
    ? (triageDocument.decisions as unknown as AdvisoryTriage[])
    : [];
  const report = evaluateDependencyAudit(await runAudit(root), decisions, {
    dependencyTypes: await directDependencyTypes(root),
    installedVersions: await installedVersions(root),
  });
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (output) {
    await mkdir(dirname(resolve(output)), { recursive: true });
    await writeFile(resolve(output), serialized, 'utf8');
  } else {
    process.stdout.write(serialized);
  }
  if (!report.passed) process.exitCode = 1;
}

const invoked = process.argv[1] ? resolve(process.argv[1]) : '';
if (invoked.endsWith(resolve('scripts/security/audit-dependencies.ts'))) {
  void main().catch((error: unknown) => {
    process.stderr.write(
      `${JSON.stringify({ event: 'security.dependencies.failed', message: error instanceof Error ? error.message : 'unknown error' })}\n`,
    );
    process.exitCode = 1;
  });
}
