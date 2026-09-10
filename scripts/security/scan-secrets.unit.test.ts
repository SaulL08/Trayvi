import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import { findPotentialSecrets, scanGitHistory } from './scan-secrets.js';

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(resolve(tmpdir(), 'trayvi-secret-scan-'));
  temporaryDirectories.push(directory);
  return directory;
}

async function git(root: string, ...arguments_: readonly string[]): Promise<void> {
  await execFileAsync('git', arguments_, { cwd: root });
}

async function initializeRepository(root: string): Promise<void> {
  await git(root, 'init');
  await git(root, 'config', 'user.email', 'security-test@trayvi.invalid');
  await git(root, 'config', 'user.name', 'Trayvi Security Test');
}

describe('secret scanner', () => {
  afterEach(async () => {
    await Promise.all(
      temporaryDirectories
        .splice(0)
        .map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  it('detects strong provider-token and private-key signatures without returning values', () => {
    const accessKey = ['AKIA', '1234567890ABCDEF'].join('');
    const privateKeyHeader = ['-----BEGIN ', 'PRIVATE KEY-----'].join('');
    const source = [accessKey, privateKeyHeader].join('\n');
    const findings = findPotentialSecrets(source, 'fixture');

    expect(findings).toEqual([
      { source: 'fixture', line: 1, pattern: 'aws-access-key' },
      { source: 'fixture', line: 2, pattern: 'private-key' },
    ]);
    expect(JSON.stringify(findings)).not.toContain(accessKey);
  });

  it('detects project credential forms using context and strength without returning values', () => {
    const databasePassword = ['T7qV', '9mZ2', 'xR5p', 'L8nC'].join('');
    const assignedPassword = ['K4vN', '8sQ1', 'bT6y', 'M9pD'].join('');
    const bearer = ['mP7xQ2vN', '4sL9dR6k', 'T1bY8cF5'].join('');
    const apiKey = ['qZ8mK3pV', '7xN2dL9s', 'R5tC1bF6'].join('');
    const privateKey = ['vT6nP2xR', '9mK4dQ7s', 'L1bZ8cF5'].join('');
    const sslKey = ['cN5rY8pM', '2vQ7tL4x', 'D9sK1bF6'].join('');
    const privateKeyHeader = ['-----BEGIN ', 'PRIVATE KEY-----'].join('');
    const source = [
      `DATABASE_URL=postgresql://trayvi:${databasePassword}@db.invalid/trayvi`,
      `password=${assignedPassword}`,
      `passwd: ${assignedPassword}`,
      `Authorization: Bearer ${bearer}`,
      `apiKey=${apiKey}`,
      `privateKey=${privateKey}`,
      `ssl_key=${sslKey}`,
      privateKeyHeader,
    ].join('\n');

    const findings = findPotentialSecrets(source, 'project-credential-fixture');

    expect(findings.map((finding) => finding.pattern)).toEqual([
      'postgresql-url-credential',
      'password-assignment',
      'password-assignment',
      'authorization-bearer',
      'api-key-assignment',
      'private-key-assignment',
      'ssl-key-assignment',
      'private-key',
    ]);
    for (const value of [databasePassword, assignedPassword, bearer, apiKey, privateKey, sslKey]) {
      expect(JSON.stringify(findings)).not.toContain(value);
    }
  });

  it('allows only explicit placeholders and obvious documentation examples', () => {
    const source = [
      'password=${DATABASE_PASSWORD}',
      'api_key=${API_KEY}',
      'password=<password-placeholder>',
      'passwd=changeme',
      'Authorization: Bearer example-placeholder-token',
      'privateKey=redacted-example-value',
      'sslKey=dummy-ssl-key',
      'DATABASE_URL=postgresql://trayvi:local-only-value@127.0.0.1/trayvi',
      'publicHash=47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU',
      'requestId=018f4f7a-3c2b-7b11-8abc-0123456789ab',
    ].join('\n');

    expect(findPotentialSecrets(source, 'allowed-example-fixture')).toEqual([]);
  });

  it('detects a project credential retained only in history', async () => {
    const root = await temporaryDirectory();
    await initializeRepository(root);
    const databasePassword = ['R8vK', '2mQ7', 'xP4t', 'N9sL'].join('');
    const file = resolve(root, 'historical-config.txt');
    await writeFile(
      file,
      `DATABASE_URL=postgresql://trayvi:${databasePassword}@db.invalid/trayvi\n`,
      'utf8',
    );
    await git(root, 'add', 'historical-config.txt');
    await git(root, 'commit', '-m', 'add contextual history fixture');
    await writeFile(file, 'removed\n', 'utf8');
    await git(root, 'add', 'historical-config.txt');
    await git(root, 'commit', '-m', 'remove contextual history fixture');

    const findings = await scanGitHistory(root);

    expect(findings.some((finding) => finding.pattern === 'postgresql-url-credential')).toBe(true);
    expect(JSON.stringify(findings)).not.toContain(databasePassword);
  });

  it('treats an initialized repository without commits as empty history', async () => {
    const root = await temporaryDirectory();
    await initializeRepository(root);

    await expect(scanGitHistory(root)).resolves.toEqual([]);
  });

  it('fails closed when Git cannot read repository history', async () => {
    const root = await temporaryDirectory();

    await expect(scanGitHistory(root)).rejects.toThrow(
      'Secret history scan requires a readable Git repository',
    );
  });

  it('streams clean history larger than the former 20 MiB buffer', async () => {
    const root = await temporaryDirectory();
    await initializeRepository(root);
    const line = `${'ordinary-foundation-evidence-'.repeat(38)}\n`;
    await writeFile(resolve(root, 'large-history.txt'), line.repeat(22_000), 'utf8');
    await git(root, 'add', 'large-history.txt');
    await git(root, 'commit', '-m', 'large clean history fixture');

    await expect(scanGitHistory(root)).resolves.toEqual([]);
  }, 30_000);

  it('detects a canary retained only in history and returns no secret value', async () => {
    const root = await temporaryDirectory();
    await initializeRepository(root);
    const canary = ['ghp', '_', 'A'.repeat(36)].join('');
    const file = resolve(root, 'historical.txt');
    await writeFile(file, `${canary}\n`, 'utf8');
    await git(root, 'add', 'historical.txt');
    await git(root, 'commit', '-m', 'add historical fixture');
    await writeFile(file, 'removed\n', 'utf8');
    await git(root, 'add', 'historical.txt');
    await git(root, 'commit', '-m', 'remove historical fixture');

    const findings = await scanGitHistory(root);

    expect(findings.some((finding) => finding.pattern === 'github-token')).toBe(true);
    expect(JSON.stringify(findings)).not.toContain(canary);
  });

  it('passes a normal clean repository history', async () => {
    const root = await temporaryDirectory();
    await initializeRepository(root);
    await writeFile(resolve(root, 'README.md'), '# Clean fixture\n', 'utf8');
    await git(root, 'add', 'README.md');
    await git(root, 'commit', '-m', 'clean fixture');

    await expect(scanGitHistory(root)).resolves.toEqual([]);
  });
});
