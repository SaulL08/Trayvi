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
    let forceTimer: NodeJS.Timeout | undefined;

    const terminate = (): void => {
      if (terminationRequested || child.exitCode !== null || child.signalCode !== null) return;
      terminationRequested = true;
      child.kill('SIGTERM');
      forceTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          terminationEscalated = true;
          child.kill('SIGKILL');
        }
      }, terminationGraceMs);
      forceTimer.unref();
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
      if (forceTimer) clearTimeout(forceTimer);
      reject(new Error(`Unable to start ${options.label}`, { cause: error }));
    });
    child.once('close', (code) => {
      clearTimeout(deadline);
      if (forceTimer) clearTimeout(forceTimer);
      if (timedOut) {
        reject(new SubprocessDeadlineError(options.label, options.timeoutMs, terminationEscalated));
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
    });
  });
}
