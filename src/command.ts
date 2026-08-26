import type { StepOptionsBase, StepRecord } from './types.ts';

export interface CommandStepOptions extends StepOptionsBase {
  command: string;
  /** Return the handle instead of throwing when the command exits non-zero. */
  allowFailure?: boolean;
  cwd?: string;
  env?: Record<string, string>;
}

/** What a command step returns to pipeline code. */
export interface CommandHandle {
  name: string;
  stdout: string;
  stderr: string;
  exitCode: number;
  cacheHit: boolean;
  step: StepRecord;
}

import { CommandFailedError } from './errors.ts';

export interface CommandOutcome {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Runs one shell command, without throwing on a non-zero exit.
 *
 * Spawned rather than run through `Bun.$` because `$` exposes no way to cancel a
 * running command: a step's `timeout` has to be able to kill the process, not just
 * stop waiting for it. `signal` carries both the run's cancellation and that deadline.
 */
export async function runCommand(
  options: CommandStepOptions,
  cwd: string,
  signal: AbortSignal,
): Promise<CommandOutcome> {
  const child = Bun.spawn(['sh', '-c', options.command], {
    cwd,
    env: options.env ? { ...process.env, ...options.env } : process.env,
    stdout: 'pipe',
    stderr: 'pipe',
    signal,
    // A command that ignores SIGTERM must not outlive the step that bounded it.
    killSignal: 'SIGKILL',
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, exitCode };
}

export function commandHandle(
  name: string,
  outcome: CommandOutcome,
  step: StepRecord,
  cacheHit: boolean,
): CommandHandle {
  return { name, ...outcome, cacheHit, step };
}

/** Throws unless the command succeeded or the step declared `allowFailure`. */
export function assertCommandOk(options: CommandStepOptions, outcome: CommandOutcome): void {
  if (outcome.exitCode === 0 || options.allowFailure) return;
  throw new CommandFailedError({ command: options.command, ...outcome });
}
