import { spawn } from 'node:child_process';

export interface BoundedProcessOptions {
  readonly cwd: string;
  readonly label: string;
  readonly timeoutMs: number;
  readonly terminationGraceMs?: number;
  readonly maxCapturedOutputBytes?: number;
  readonly acceptedExitCodes?: readonly number[];
  readonly captureStdout?: boolean;
  readonly onStdout?: (chunk: string) => void;
}

export interface BoundedProcessResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export class SubprocessDeadlineError extends Error {
  readonly partialOutputDiscarded = true;
  readonly terminationEscalated: boolean;

  constructor(label: string, timeoutMs: number, terminationEscalated: boolean) {
    super(`${label} exceeded its ${String(timeoutMs)} ms deadline; partial output was discarded`);
    this.name = 'SubprocessDeadlineError';
    this.terminationEscalated = terminationEscalated;
  }
}

export class SubprocessExecutionError extends Error {
  readonly exitCode: number | null;

  constructor(label: string, exitCode: number | null) {
    super(`${label} failed with exit code ${exitCode === null ? 'none' : String(exitCode)}`);
    this.name = 'SubprocessExecutionError';
    this.exitCode = exitCode;
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function posixProcessGroupExists(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function signalPosixProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}

async function waitForPosixProcessGroupExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (posixProcessGroupExists(pid)) {
    if (Date.now() >= deadline) return false;
    await delay(10);
  }
  return true;
}

async function terminateWindowsProcessTree(pid: number, label: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const terminator = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    terminator.once('error', (error) => {
      reject(new Error(`Unable to terminate ${label} process tree`, { cause: error }));
    });
    terminator.once('close', (code) => {
      if (code === 0) resolve();
      else {
        try {
          process.kill(pid, 'SIGKILL');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
            reject(new Error(`Unable to terminate ${label} process tree`, { cause: error }));
            return;
          }
        }
        reject(new Error(`Unable to confirm ${label} process tree cleanup`));
      }
    });
  });
}

async function terminatePosixProcessTree(
  pid: number,
  graceMs: number,
  markEscalated: () => void,
  label: string,
): Promise<void> {
  signalPosixProcessGroup(pid, 'SIGTERM');
  if (await waitForPosixProcessGroupExit(pid, graceMs)) return;

  markEscalated();
  signalPosixProcessGroup(pid, 'SIGKILL');
  if (!(await waitForPosixProcessGroupExit(pid, Math.max(graceMs, 1_000)))) {
    throw new Error(`Unable to confirm ${label} process tree cleanup`);
  }
}

export async function runBoundedProcess(
  command: string,
  arguments_: readonly string[],
  options: BoundedProcessOptions,
): Promise<BoundedProcessResult> {
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0)
    throw new Error('Subprocess timeout must be a positive integer');
  const terminationGraceMs = options.terminationGraceMs ?? 1_000;
  const acceptedExitCodes = options.acceptedExitCodes ?? [0];
  const captureStdout = options.captureStdout ?? true;

  return await new Promise((fulfill, reject) => {
    const child = spawn(command, [...arguments_], {
      cwd: options.cwd,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let capturedBytes = 0;
    let timedOut = false;
    let outputLimitExceeded = false;
    let terminationEscalated = false;
    let terminationRequested = false;
    let terminationPromise: Promise<void> | undefined;

    const terminate = (): void => {
      if (terminationRequested || child.exitCode !== null || child.signalCode !== null) return;
      terminationRequested = true;
      const pid = child.pid;
      if (pid === undefined) {
        terminationPromise = Promise.reject(
          new Error(`Unable to identify ${options.label} process tree`),
        );
        return;
      }
      if (process.platform === 'win32') {
        terminationEscalated = true;
        terminationPromise = terminateWindowsProcessTree(pid, options.label);
      } else {
        terminationPromise = terminatePosixProcessTree(
          pid,
          terminationGraceMs,
          () => {
            terminationEscalated = true;
          },
          options.label,
        );
      }
      void terminationPromise.catch(() => undefined);
    };
    const deadline = setTimeout(() => {
      timedOut = true;
      terminate();
    }, options.timeoutMs);
    deadline.unref();

    const capture = (chunk: string, stream: 'stdout' | 'stderr'): void => {
      capturedBytes += Buffer.byteLength(chunk);
      if (
        options.maxCapturedOutputBytes !== undefined &&
        capturedBytes > options.maxCapturedOutputBytes
      ) {
        outputLimitExceeded = true;
        terminate();
        return;
      }
      if (stream === 'stdout') {
        if (captureStdout) stdout += chunk;
        try {
          options.onStdout?.(chunk);
        } catch {
          outputLimitExceeded = true;
          terminate();
        }
      } else {
        stderr += chunk;
      }
    };

    child.stdout.setEncoding('utf8').on('data', (chunk: string) => capture(chunk, 'stdout'));
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => capture(chunk, 'stderr'));
    child.once('error', (error) => {
      clearTimeout(deadline);
      reject(new Error(`Unable to start ${options.label}`, { cause: error }));
    });
    child.once('close', (code) => {
      void (async () => {
        clearTimeout(deadline);
        try {
          await terminationPromise;
        } catch (error) {
          reject(error);
          return;
        }
        if (timedOut) {
          reject(
            new SubprocessDeadlineError(options.label, options.timeoutMs, terminationEscalated),
          );
          return;
        }
        if (outputLimitExceeded) {
          reject(
            new Error(
              `${options.label} exceeded its safe output limit; partial output was discarded`,
            ),
          );
          return;
        }
        if (code === null || !acceptedExitCodes.includes(code)) {
          reject(new SubprocessExecutionError(options.label, code));
          return;
        }
        fulfill({ stdout, stderr, exitCode: code });
      })();
    });
  });
}
