import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { runBoundedProcess } from './bounded-process.js';

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

export interface GitScanDeadlineOptions {
  readonly metadataTimeoutMs?: number;
  readonly historyTimeoutMs?: number;
  readonly terminationGraceMs?: number;
}

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

async function repositoryFiles(
  root: string,
  options: GitScanDeadlineOptions,
): Promise<readonly string[]> {
  const result = await runBoundedProcess(
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
    {
      cwd: root,
      label: 'Git repository file enumeration',
      timeoutMs: options.metadataTimeoutMs ?? 15_000,
      ...(options.terminationGraceMs === undefined
        ? {}
        : { terminationGraceMs: options.terminationGraceMs }),
      maxCapturedOutputBytes: 64 * 1_024 * 1_024,
    },
  );
  return result.stdout.split('\0').filter(Boolean);
}

async function assertGitRepository(root: string, options: GitScanDeadlineOptions): Promise<void> {
  try {
    const { stdout } = await runBoundedProcess(
      'git',
      ['-c', `safe.directory=${root.replaceAll('\\', '/')}`, 'rev-parse', '--is-inside-work-tree'],
      {
        cwd: root,
        label: 'Git repository validation',
        timeoutMs: options.metadataTimeoutMs ?? 15_000,
        ...(options.terminationGraceMs === undefined
          ? {}
          : { terminationGraceMs: options.terminationGraceMs }),
        maxCapturedOutputBytes: 64 * 1_024,
      },
    );
    if (stdout.trim() !== 'true') throw new Error('Git did not identify a working tree');
  } catch (error) {
    throw new Error('Secret history scan requires a readable Git repository', { cause: error });
  }
}

async function reachableCommitCount(
  root: string,
  options: GitScanDeadlineOptions,
): Promise<number> {
  try {
    const { stdout } = await runBoundedProcess(
      'git',
      ['-c', `safe.directory=${root.replaceAll('\\', '/')}`, 'rev-list', '--all', '--count'],
      {
        cwd: root,
        label: 'Git history enumeration',
        timeoutMs: options.metadataTimeoutMs ?? 15_000,
        ...(options.terminationGraceMs === undefined
          ? {}
          : { terminationGraceMs: options.terminationGraceMs }),
        maxCapturedOutputBytes: 64 * 1_024,
      },
    );
    const count = Number.parseInt(stdout.trim(), 10);
    if (!Number.isSafeInteger(count) || count < 0) throw new Error('Invalid Git commit count');
    return count;
  } catch (error) {
    throw new Error('Unable to enumerate Git history for secret scanning', { cause: error });
  }
}

export async function scanGitHistory(
  root: string,
  options: GitScanDeadlineOptions = {},
): Promise<readonly SecretFinding[]> {
  await assertGitRepository(root, options);
  if ((await reachableCommitCount(root, options)) === 0) return [];

  const findings: SecretFinding[] = [];
  let pending = '';
  let lineNumber = 0;
  const inspectLine = (line: string): void => {
    lineNumber += 1;
    for (const finding of findPotentialSecrets(line, 'git-history')) {
      findings.push({ ...finding, line: lineNumber });
    }
  };
  await runBoundedProcess(
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
    {
      cwd: root,
      label: 'Git history secret scan',
      timeoutMs: options.historyTimeoutMs ?? 120_000,
      ...(options.terminationGraceMs === undefined
        ? {}
        : { terminationGraceMs: options.terminationGraceMs }),
      captureStdout: false,
      onStdout: (chunk) => {
        const lines = `${pending}${chunk}`.split(/\r?\n/u);
        pending = lines.pop() ?? '';
        for (const line of lines) inspectLine(line);
      },
    },
  );
  if (pending) inspectLine(pending);
  return findings;
}

export async function scanRepository(
  root: string,
  options: GitScanDeadlineOptions = {},
): Promise<readonly SecretFinding[]> {
  const findings: SecretFinding[] = [];
  for (const file of await repositoryFiles(root, options)) {
    try {
      const content = await readFile(resolve(root, file), 'utf8');
      findings.push(...findPotentialSecrets(content, file));
    } catch {
      // Binary or concurrently removed files are not interpreted as text.
    }
  }

  findings.push(...(await scanGitHistory(root, options)));
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
