import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export interface LicenseRecord {
  readonly name: string;
  readonly version: string;
  readonly license: string;
}

export interface LicenseFinding extends LicenseRecord {
  readonly reason: 'missing-license' | 'prohibited-license';
}

const prohibitedLicense = /\b(?:AGPL|GPL|SSPL|BUSL|COMMONS CLAUSE|ELASTIC LICENSE)\b/iu;

function licenseText(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) return value.map(licenseText).filter(Boolean).join(' OR ');
  if (value && typeof value === 'object' && 'type' in value) {
    return licenseText(value.type);
  }
  return '';
}

export function evaluateLicenseRecords(
  records: readonly LicenseRecord[],
): readonly LicenseFinding[] {
  const findings: LicenseFinding[] = [];
  for (const record of records) {
    if (!record.license) {
      findings.push({ ...record, reason: 'missing-license' });
      continue;
    }
    if (prohibitedLicense.test(record.license)) {
      findings.push({ ...record, reason: 'prohibited-license' });
    }
  }
  return findings;
}

async function collectPackageLicenses(directory: string): Promise<readonly LicenseRecord[]> {
  const records = new Map<string, LicenseRecord>();

  async function walk(current: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true });
    const packageEntry = entries.find((entry) => entry.isFile() && entry.name === 'package.json');
    if (packageEntry) {
      try {
        const parsed = JSON.parse(await readFile(resolve(current, packageEntry.name), 'utf8')) as {
          readonly name?: unknown;
          readonly version?: unknown;
          readonly license?: unknown;
          readonly licenses?: unknown;
        };
        if (typeof parsed.name === 'string' && typeof parsed.version === 'string') {
          const record: LicenseRecord = {
            name: parsed.name,
            version: parsed.version,
            license: licenseText(parsed.license ?? parsed.licenses),
          };
          records.set(`${record.name}@${record.version}`, record);
        }
      } catch {
        // Invalid package metadata is reported by install/build checks rather than leaking raw text.
      }
      return;
    }

    for (const entry of entries) {
      if (entry.isDirectory()) await walk(resolve(current, entry.name));
    }
  }

  await walk(directory);
  return [...records.values()].sort((left, right) =>
    `${left.name}@${left.version}`.localeCompare(`${right.name}@${right.version}`),
  );
}

async function main(): Promise<void> {
  const records = await collectPackageLicenses(resolve('node_modules/.pnpm'));
  const findings = evaluateLicenseRecords(records);
  process.stdout.write(
    `${JSON.stringify({
      event: 'security.licenses.checked',
      passed: findings.length === 0,
      packages: records.length,
      findings,
    })}\n`,
  );
  if (findings.length > 0) process.exitCode = 1;
}

const invoked = process.argv[1] ? resolve(process.argv[1]) : '';
if (invoked.endsWith(resolve('scripts/security/check-licenses.ts'))) {
  void main();
}
