// Pure rules for spec work-stream manifests (ADR-020). Git and filesystem access live in spec.ts.

export const specStatuses = ['draft', 'approved', 'in-progress', 'integrated'] as const;
export type SpecStatus = (typeof specStatuses)[number];

export interface StreamDefinition {
  readonly id: string;
  readonly title: string;
  readonly owns: readonly string[];
  readonly dependsOn: readonly string[];
  readonly migrations: readonly string[];
  readonly acceptance: readonly string[];
  readonly verify: readonly string[];
}

export interface SpecManifest {
  readonly spec: string;
  readonly title: string;
  readonly phase: string;
  readonly status: SpecStatus;
  readonly base: string;
  readonly streams: readonly StreamDefinition[];
}

export interface ManifestIssue {
  readonly code: string;
  readonly spec: string;
  readonly detail: string;
}

/** Paths every stream tends to touch. Only the integration branch may change them. */
export const integrationOwnedPaths: readonly string[] = [
  '.github/',
  '.gitattributes',
  '.gitignore',
  '.node-version',
  '.nvmrc',
  '.prettierignore',
  'docs/adr/README.md',
  'eslint.config.mjs',
  'infra/database/migrations/',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'prettier.config.mjs',
  'tsconfig.base.json',
  'tsconfig.json',
  'turbo.json',
  'vitest.config.ts',
];

export const migrationsDirectory = 'infra/database/migrations/';

const specIdPattern = /^SPEC-(\d{3})-([a-z0-9]+(?:-[a-z0-9]+)*)$/u;
const streamIdPattern = /^ws-[a-z]$/u;
const migrationPattern = /^\d{4}$/u;
const acceptancePattern = /^(?:P\d+[A-Z]?-)?AC-\d{3}$/u;

export function integrationBranch(specId: string): string {
  return `${specBranchPrefix(specId)}/integration`;
}

export function streamBranch(specId: string, streamId: string): string {
  return `${specBranchPrefix(specId)}/${streamId}`;
}

export function specBranchPrefix(specId: string): string {
  const match = specIdPattern.exec(specId);
  if (!match) throw new Error(`Invalid spec identifier: ${specId}`);
  return `spec/${match[1]}-${match[2]}`;
}

/** Ownership entries are exact files or directories ending in `/`; globs are not accepted. */
export function covers(owner: string, path: string): boolean {
  return owner === path || (owner.endsWith('/') && path.startsWith(owner));
}

function overlaps(left: string, right: string): boolean {
  return covers(left, right) || covers(right, left);
}

function isPackageManifest(path: string): boolean {
  return path === 'package.json' || path.endsWith('/package.json');
}

function validOwnershipPath(path: string): boolean {
  return (
    path.length > 0 &&
    !path.startsWith('/') &&
    !path.includes('\\') &&
    !path.includes('*') &&
    path
      .split('/')
      .every((segment, index, all) =>
        index === all.length - 1 && path.endsWith('/')
          ? segment === ''
          : segment !== '' && segment !== '.' && segment !== '..',
      )
  );
}

function stringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

/** Parses untrusted JSON into a manifest, reporting every shape error instead of throwing. */
export function parseManifest(
  raw: unknown,
  source: string,
): { readonly manifest?: SpecManifest; readonly issues: readonly ManifestIssue[] } {
  const issues: ManifestIssue[] = [];
  const fail = (detail: string) => issues.push({ code: 'manifest-shape', spec: source, detail });

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    fail('manifest must be a JSON object');
    return { issues };
  }
  const record = raw as Record<string, unknown>;
  for (const key of ['spec', 'title', 'phase', 'status', 'base'] as const) {
    if (typeof record[key] !== 'string' || record[key] === '')
      fail(`"${key}" must be a non-empty string`);
  }
  if (
    typeof record.status === 'string' &&
    !(specStatuses as readonly string[]).includes(record.status)
  ) {
    fail(`"status" must be one of ${specStatuses.join(', ')}`);
  }
  if (!Array.isArray(record.streams) || record.streams.length === 0) {
    fail('"streams" must be a non-empty array');
    return { issues };
  }

  const streams: StreamDefinition[] = [];
  record.streams.forEach((entry: unknown, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      fail(`streams[${index}] must be an object`);
      return;
    }
    const stream = entry as Record<string, unknown>;
    let valid = true;
    for (const key of ['id', 'title'] as const) {
      if (typeof stream[key] !== 'string' || stream[key] === '') {
        fail(`streams[${index}].${key} must be a non-empty string`);
        valid = false;
      }
    }
    for (const key of ['owns', 'dependsOn', 'migrations', 'acceptance', 'verify'] as const) {
      if (!stringArray(stream[key])) {
        fail(`streams[${index}].${key} must be an array of strings`);
        valid = false;
      }
    }
    if (valid) streams.push(stream as unknown as StreamDefinition);
  });

  if (issues.length > 0) return { issues };
  return { manifest: { ...(record as unknown as SpecManifest), streams }, issues };
}

/** Returns stream ids grouped into waves; each wave depends only on earlier waves. */
export function mergeWaves(manifest: SpecManifest): readonly (readonly string[])[] {
  const remaining = new Map(
    manifest.streams.map((stream) => [stream.id, new Set(stream.dependsOn)]),
  );
  const waves: string[][] = [];
  while (remaining.size > 0) {
    const wave = [...remaining]
      .filter(([, dependencies]) => dependencies.size === 0)
      .map(([id]) => id)
      .sort();
    if (wave.length === 0)
      throw new Error(`Dependency cycle among ${[...remaining.keys()].join(', ')}`);
    waves.push(wave);
    for (const id of wave) remaining.delete(id);
    for (const dependencies of remaining.values()) for (const id of wave) dependencies.delete(id);
  }
  return waves;
}

/** Validates one manifest against its location and the structural rules of ADR-020. */
export function validateManifest(
  manifest: SpecManifest,
  location: { readonly phaseDirectory: string; readonly specDirectory: string },
): readonly ManifestIssue[] {
  const issues: ManifestIssue[] = [];
  const add = (code: string, detail: string) => issues.push({ code, spec: manifest.spec, detail });

  if (!specIdPattern.test(manifest.spec))
    add('spec-id', `"${manifest.spec}" must match SPEC-NNN-kebab-slug`);
  if (manifest.spec !== location.specDirectory) {
    add('spec-location', `directory "${location.specDirectory}" must equal the spec id`);
  }
  if (manifest.phase !== location.phaseDirectory) {
    add(
      'spec-location',
      `"phase" must equal the owning phase directory "${location.phaseDirectory}"`,
    );
  }

  const ids = new Set<string>();
  for (const stream of manifest.streams) {
    if (!streamIdPattern.test(stream.id)) add('stream-id', `"${stream.id}" must match ws-[a-z]`);
    if (ids.has(stream.id)) add('stream-id', `"${stream.id}" is declared twice`);
    ids.add(stream.id);
  }

  const specDocs = `docs/phases/${location.phaseDirectory}/specs/${location.specDirectory}/`;
  const claimedMigrations = new Map<string, string>();
  for (const stream of manifest.streams) {
    if (stream.owns.length === 0) add('ownership', `${stream.id} owns no paths`);
    if (stream.acceptance.length === 0)
      add('acceptance', `${stream.id} traces to no acceptance criterion`);
    if (stream.verify.length === 0) add('verify', `${stream.id} declares no verification command`);
    for (const criterion of stream.acceptance) {
      if (!acceptancePattern.test(criterion))
        add('acceptance', `${stream.id}: "${criterion}" is not an AC id`);
    }
    for (const dependency of stream.dependsOn) {
      if (dependency === stream.id) add('dependency', `${stream.id} depends on itself`);
      else if (!ids.has(dependency))
        add('dependency', `${stream.id} depends on unknown stream "${dependency}"`);
    }
    for (const path of stream.owns) {
      if (!validOwnershipPath(path)) {
        add(
          'ownership',
          `${stream.id}: "${path}" must be a relative file or a directory ending in "/", without globs`,
        );
        continue;
      }
      if (isPackageManifest(path))
        add('ownership', `${stream.id}: package manifests are integration-owned`);
      for (const shared of integrationOwnedPaths) {
        if (overlaps(shared, path))
          add('ownership', `${stream.id}: "${path}" overlaps integration-owned "${shared}"`);
      }
      if (overlaps(specDocs, path))
        add('ownership', `${stream.id}: the spec documents are frozen for streams`);
    }
    for (const number of stream.migrations) {
      if (!migrationPattern.test(number))
        add('migration', `${stream.id}: "${number}" must be four digits`);
      const holder = claimedMigrations.get(number);
      if (holder) add('migration', `${number} is reserved by both ${holder} and ${stream.id}`);
      claimedMigrations.set(number, stream.id);
    }
  }

  for (const [index, left] of manifest.streams.entries()) {
    for (const right of manifest.streams.slice(index + 1)) {
      for (const leftPath of left.owns) {
        for (const rightPath of right.owns) {
          if (overlaps(leftPath, rightPath)) {
            add('ownership', `${left.id} "${leftPath}" overlaps ${right.id} "${rightPath}"`);
          }
        }
      }
    }
  }

  const dependencyIssues = issues.some((issue) => issue.code === 'dependency');
  if (!dependencyIssues) {
    try {
      mergeWaves(manifest);
    } catch (error) {
      add('dependency', (error as Error).message);
    }
  }
  return issues;
}

/** Cross-manifest rules: unique spec numbers and no migration reserved twice by unfinished specs. */
export function validateManifestSet(manifests: readonly SpecManifest[]): readonly ManifestIssue[] {
  const issues: ManifestIssue[] = [];
  const numbers = new Map<string, string>();
  const migrations = new Map<string, string>();
  for (const manifest of manifests) {
    const number = specIdPattern.exec(manifest.spec)?.[1];
    if (number) {
      const holder = numbers.get(number);
      if (holder)
        issues.push({
          code: 'spec-id',
          spec: manifest.spec,
          detail: `number ${number} is also used by ${holder}`,
        });
      numbers.set(number, manifest.spec);
    }
    if (manifest.status === 'integrated') continue;
    for (const stream of manifest.streams) {
      for (const migration of stream.migrations) {
        const holder = migrations.get(migration);
        if (holder && holder !== manifest.spec) {
          issues.push({
            code: 'migration',
            spec: manifest.spec,
            detail: `${migration} is also reserved by ${holder}`,
          });
        }
        migrations.set(migration, manifest.spec);
      }
    }
  }
  return issues;
}

/** Lists changed paths a stream branch is not allowed to touch. */
export function ownershipViolations(
  stream: StreamDefinition,
  changedPaths: readonly string[],
): readonly string[] {
  const migrationPrefixes = stream.migrations.map((number) => `${migrationsDirectory}${number}_`);
  return changedPaths.filter(
    (path) =>
      !stream.owns.some((owner) => covers(owner, path)) &&
      !(
        path.startsWith(migrationsDirectory) &&
        migrationPrefixes.some((prefix) => path.startsWith(prefix)) &&
        !path.slice(migrationsDirectory.length).includes('/')
      ),
  );
}

/** Maps a branch name back to its spec and stream, when it follows the naming rule. */
export function parseBranch(
  branch: string,
): { readonly prefix: string; readonly role: string } | undefined {
  const match = /^(spec\/\d{3}-[a-z0-9]+(?:-[a-z0-9]+)*)\/(integration|ws-[a-z])$/u.exec(branch);
  return match ? { prefix: match[1] as string, role: match[2] as string } : undefined;
}
