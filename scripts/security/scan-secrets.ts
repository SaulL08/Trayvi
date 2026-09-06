import { execFile, execFileSync, spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

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

const execFileAsync = promisify(execFile);

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

async function assertGitRepository(root: string): Promise<void> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-c', `safe.directory=${root.replaceAll('\\', '/')}`, 'rev-parse', '--is-inside-work-tree'],
      { cwd: root, encoding: 'utf8' },
    );
    if (stdout.trim() !== 'true') throw new Error('Git did not identify a working tree');
  } catch (error) {
    throw new Error('Secret history scan requires a readable Git repository', { cause: error });
  }
}

async function reachableCommitCount(root: string): Promise<number> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-c', `safe.directory=${root.replaceAll('\\', '/')}`, 'rev-list', '--all', '--count'],
      { cwd: root, encoding: 'utf8' },
    );
    const count = Number.parseInt(stdout.trim(), 10);
    if (!Number.isSafeInteger(count) || count < 0) throw new Error('Invalid Git commit count');
    return count;
  } catch (error) {
    throw new Error('Unable to enumerate Git history for secret scanning', { cause: error });
  }
}

export async function scanGitHistory(root: string): Promise<readonly SecretFinding[]> {
  await assertGitRepository(root);
  if ((await reachableCommitCount(root)) === 0) return [];

  return await new Promise((fulfill, reject) => {
    const findings: SecretFinding[] = [];
    const child = spawn(
      'git',
      [
        '-c',
        `safe.directory=${root.replaceAll('\\', '/')}`,
        'log',
        '-p',
        '--all',
        '--no-ext-diff',
        '--text',
      ],
      { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    let pending = '';
    let lineNumber = 0;

    const inspectLine = (line: string): void => {
      lineNumber += 1;
      for (const finding of findPotentialSecrets(line, 'git-history')) {
        findings.push({ ...finding, line: lineNumber });
      }
    };

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      const lines = `${pending}${chunk}`.split(/\r?\n/u);
      pending = lines.pop() ?? '';
      for (const line of lines) inspectLine(line);
    });
    child.on('error', (error) => {
      reject(new Error('Unable to start Git history scan', { cause: error }));
    });
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`Git history scan failed with exit code ${String(code)}`));
        return;
      }
      if (pending) inspectLine(pending);
      fulfill(findings);
    });
  });
}

export async function scanRepository(root: string): Promise<readonly SecretFinding[]> {
  const findings: SecretFinding[] = [];
  for (const file of repositoryFiles(root)) {
    try {
      const content = await readFile(resolve(root, file), 'utf8');
      findings.push(...findPotentialSecrets(content, file));
    } catch {
      // Binary or concurrently removed files are not interpreted as text.
    }
  }

  findings.push(...(await scanGitHistory(root)));
  return findings;
}

const invoked = process.argv[1] ? resolve(process.argv[1]) : '';
if (invoked.endsWith(resolve('scripts/security/scan-secrets.ts'))) {
  void scanRepository(process.cwd())
    .then((findings) => {
      process.stdout.write(
        `${JSON.stringify({ event: 'security.secrets.scanned', passed: findings.length === 0, findings })}\n`,
      );
      if (findings.length > 0) process.exitCode = 1;
    })
    .catch((error: unknown) => {
      process.stderr.write(
        `${JSON.stringify({ event: 'security.secrets.failed', message: error instanceof Error ? error.message : 'unknown error' })}\n`,
      );
      process.exitCode = 1;
    });
}
