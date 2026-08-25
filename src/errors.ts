/**
 * A deliberate, successful early termination of a run. Thrown by `ctx.halt()`
 * and caught by the runner, which records the run as halted rather than failed.
 *
 * Pipeline code should never catch this. If you wrap steps in `try`/`catch`,
 * rethrow it (or use `isHalt()`), otherwise a halt turns into ordinary control
 * flow and the run continues past the point you meant to stop.
 */
export class HaltSignal extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(`Pipeline halted: ${reason}`);
    this.name = 'HaltSignal';
    this.reason = reason;
  }
}

export function isHalt(value: unknown): value is HaltSignal {
  return value instanceof HaltSignal;
}

/** A step threw. Wraps the original error, which stays on `cause`. */
export class StepFailedError extends Error {
  readonly stepName: string;

  constructor(stepName: string, cause: unknown) {
    super(`Step "${stepName}" failed: ${messageOf(cause)}`, { cause });
    this.name = 'StepFailedError';
    this.stepName = stepName;
  }
}

/** A command step exited non-zero and did not declare `allowFailure`. */
export class CommandFailedError extends Error {
  readonly command: string;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;

  constructor(args: { command: string; exitCode: number; stdout: string; stderr: string }) {
    super(`Command exited ${args.exitCode}: ${args.command}\n${args.stderr.trim()}`);
    this.name = 'CommandFailedError';
    this.command = args.command;
    this.exitCode = args.exitCode;
    this.stdout = args.stdout;
    this.stderr = args.stderr;
  }
}

/** A Claude step could not produce a usable Output. */
export class ClaudeStepError extends Error {
  readonly stepName: string;
  readonly attempts: number;

  constructor(stepName: string, attempts: number, cause: unknown) {
    super(
      `Claude step "${stepName}" failed after ${attempts} attempt(s): ${messageOf(cause)}`,
      { cause },
    );
    this.name = 'ClaudeStepError';
    this.stepName = stepName;
    this.attempts = attempts;
  }
}

/** The value passed as a run's `input` did not satisfy the pipeline's input schema. */
export class PipelineInputError extends Error {
  constructor(pipeline: string, cause: unknown) {
    super(`Input to pipeline "${pipeline}" is invalid: ${messageOf(cause)}`, { cause });
    this.name = 'PipelineInputError';
  }
}

export function messageOf(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
