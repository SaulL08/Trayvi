import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

interface SecretPattern {
  readonly name: string;
  readonly expression: RegExp;
}

export interface SecretFinding {
  readonly source: string;
  readonly line: number;
  readonly pattern: string;
}

const patterns: readonly SecretPattern[] = [
  { name: 'private-key', expression: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u },
  { name: 'aws-access-key', expression: /\bAKIA[0-9A-Z]{16}\b/u },
  { name: 'github-token', expression: /\bgh[pousr]_[A-Za-z0-9]{36,255}\b/u },
  { name: 'slack-token', expression: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/u },
  { name: 'npm-token', expression: /\bnpm_[A-Za-z0-9]{36,}\b/u },
  { name: 'stripe-live-key', expression: /\b(?:sk|rk)_live_[A-Za-z0-9]{20,}\b/u },
  {
    name: 'hardcoded-bearer',
    expression: /\bBearer\s+[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/u,
  },
];

export function findPotentialSecrets(source: string, label: string): readonly SecretFinding[] {
  const findings: SecretFinding[] = [];
  for (const [index, line] of source.split(/\r?\n/u).entries()) {
    for (const pattern of patterns) {
      pattern.expression.lastIndex = 0;
      if (pattern.expression.test(line)) {
        findings.push({ source: label, line: index + 1, pattern: pattern.name });
      }
    }
  }
  return findings;
}

function repositoryFiles(root: string): readonly string[] {
  const output = execFileSync(
    'git',
    [
      '-c',
      `safe.directory=${root.replaceAll('\\', '/')}`,
      'ls-files',
      '--cached',
      '--others',
      '--exclude-standard',
      '-z',
    ],
    { cwd: root, encoding: 'utf8' },
  );
  return output.split('\0').filter(Boolean);
}

async function scanRepository(root: string): Promise<readonly SecretFinding[]> {
  const findings: SecretFinding[] = [];
  for (const file of repositoryFiles(root)) {
    try {
      const content = await readFile(resolve(root, file), 'utf8');
      findings.push(...findPotentialSecrets(content, file));
    } catch {
      // Binary or concurrently removed files are not interpreted as text.
    }
  }

  try {
    const history = execFileSync(
      'git',
      ['-c', `safe.directory=${root.replaceAll('\\', '/')}`, 'log', '-p', '--all', '--no-ext-diff'],
      { cwd: root, encoding: 'utf8', maxBuffer: 20 * 1_024 * 1_024 },
    );
    findings.push(...findPotentialSecrets(history, 'git-history'));
  } catch {
    // An initialized repository without commits has no history to scan.
  }
  return findings;
}

const invoked = process.argv[1] ? resolve(process.argv[1]) : '';
if (invoked.endsWith(resolve('scripts/security/scan-secrets.ts'))) {
  void scanRepository(process.cwd()).then((findings) => {
    process.stdout.write(
      `${JSON.stringify({ event: 'security.secrets.scanned', passed: findings.length === 0, findings })}\n`,
    );
    if (findings.length > 0) process.exitCode = 1;
  });
}
