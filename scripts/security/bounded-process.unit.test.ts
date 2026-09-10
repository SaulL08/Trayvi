import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  runBoundedProcess,
  SubprocessDeadlineError,
  SubprocessExecutionError,
} from './bounded-process.js';

const root = resolve('.');

async function processIsRunning(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    if (process.platform !== 'linux') return true;
    const status = await readFile(`/proc/${String(pid)}/stat`, 'utf8');
    return status.split(' ')[2] !== 'Z';
  } catch {
    return false;
  }
}

describe('bounded security subprocess execution', () => {
  it('returns complete output only after normal success', async () => {
    const result = await runBoundedProcess(
      process.execPath,
      ['-e', "process.stdout.write('complete')"],
      { cwd: root, label: 'success fixture', timeoutMs: 2_000 },
    );

    expect(result).toEqual({ stdout: 'complete', stderr: '', exitCode: 0 });
  });

  it('fails closed on a nonzero exit', async () => {
    await expect(
      runBoundedProcess(process.execPath, ['-e', 'process.exit(2)'], {
        cwd: root,
        label: 'nonzero fixture',
        timeoutMs: 2_000,
      }),
    ).rejects.toMatchObject({ name: SubprocessExecutionError.name, exitCode: 2 });
  });

  it('terminates a hanging child at its internal deadline', async () => {
    await expect(
      runBoundedProcess(process.execPath, ['-e', 'setInterval(() => undefined, 1000)'], {
        cwd: root,
        label: 'hang fixture',
        timeoutMs: 100,
        terminationGraceMs: 50,
      }),
    ).rejects.toMatchObject({ name: SubprocessDeadlineError.name, partialOutputDiscarded: true });
  });

  it('never accepts partial output from a timed-out child', async () => {
    const execution = runBoundedProcess(
      process.execPath,
      ['-e', 'process.stdout.write(\'{"passed":true\'); setInterval(() => undefined, 1000)'],
      {
        cwd: root,
        label: 'partial fixture',
        timeoutMs: 100,
        terminationGraceMs: 50,
      },
    );

    await expect(execution).rejects.toThrow('partial output was discarded');
    await expect(execution).rejects.not.toThrow('passed');
  });

  it.skipIf(process.platform === 'win32')(
    'escalates termination when a child ignores the graceful signal',
    async () => {
      await expect(
        runBoundedProcess(
          process.execPath,
          ['-e', "process.on('SIGTERM', () => undefined); setInterval(() => undefined, 1000)"],
          {
            cwd: root,
            label: 'signal-resistant fixture',
            timeoutMs: 200,
            terminationGraceMs: 100,
          },
        ),
      ).rejects.toMatchObject({
        name: SubprocessDeadlineError.name,
        terminationEscalated: true,
      });
    },
  );

  it('terminates a resistant descendant before rejecting a timed-out process tree', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'trayvi-process-tree-'));
    const descendantPidFile = resolve(directory, 'descendant.pid');
    let descendantPid: number | undefined;
    const descendantSource = [
      "if (process.platform !== 'win32') process.on('SIGTERM', () => undefined);",
      'setInterval(() => undefined, 1000);',
    ].join(' ');
    const parentSource = [
      "const { spawn } = require('node:child_process');",
      "const { writeFileSync } = require('node:fs');",
      `const descendant = spawn(process.execPath, ['-e', ${JSON.stringify(descendantSource)}], { stdio: 'ignore' });`,
      `writeFileSync(${JSON.stringify(descendantPidFile)}, String(descendant.pid));`,
      "if (process.platform !== 'win32') process.on('SIGTERM', () => undefined);",
      'setInterval(() => undefined, 1000);',
    ].join(' ');

    try {
      await expect(
        runBoundedProcess(process.execPath, ['-e', parentSource], {
          cwd: root,
          label: 'process-tree fixture',
          timeoutMs: 500,
          terminationGraceMs: 150,
        }),
      ).rejects.toMatchObject({
        name: SubprocessDeadlineError.name,
        partialOutputDiscarded: true,
        terminationEscalated: true,
      });
      descendantPid = Number.parseInt(await readFile(descendantPidFile, 'utf8'), 10);
      expect(Number.isSafeInteger(descendantPid)).toBe(true);
      expect(await processIsRunning(descendantPid)).toBe(false);
    } finally {
      if (descendantPid !== undefined && (await processIsRunning(descendantPid))) {
        process.kill(descendantPid, 'SIGKILL');
      }
      await rm(directory, { recursive: true, force: true });
    }
  });
});
