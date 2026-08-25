import { $ } from 'bun';
import type { CommandHandle, CommandStepOptions, StepRecord } from './types.ts';
import { CommandFailedError } from './errors.ts';
import type { Runner } from './runner.ts';

export interface CommandOutcome {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Runs one shell command under `Bun.$`, without throwing on a non-zero exit. */
export async function runCommand(
  options: CommandStepOptions,
  cwd: string,
): Promise<CommandOutcome> {
  let shell = $`${{ raw: options.command }}`.cwd(cwd).quiet().nothrow();
  if (options.env) shell = shell.env({ ...process.env, ...options.env });
  const result = await shell;
  return {
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
    exitCode: result.exitCode,
  };
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

export type { Runner };
