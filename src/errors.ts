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

/**
 * A resumed run reached a step that a crash left in flight, and nothing could settle
 * whether its work landed: it declared no `reconcile`, or one that could not answer, and
 * its crash policy is `'fail'`.
 *
 * This is the run stopping rather than guessing. Establish what happened, then resume
 * again — a step whose effect turns out to have landed is settled by giving it a
 * `reconcile`; one that did not is settled by `onCrash: 'rerun'`.
 */
export class IndeterminateStepError extends Error {
  readonly stepName: string;
  /** Id of the step, in the crashed run, that was left in flight. */
  readonly priorStepId: string;

  constructor(stepName: string, priorStepId: string) {
    super(
      `Step "${stepName}" was left in flight by a run that stopped, and it is not known ` +
        'whether its work took effect. Give it a `reconcile` to ask, or `onCrash: ' +
        "'rerun'` if repeating it is safe.",
    );
    this.name = 'IndeterminateStepError';
    this.stepName = stepName;
    this.priorStepId = priorStepId;
  }
}

/**
 * Another process claimed the abandoned run this one tried to take over. Two supervisors
 * polling the same stale run is the ordinary case, not an error in either of them: the
 * one that loses stops, and the one that won finishes the work.
 */
export class RunTakenError extends Error {
  readonly runId: string;

  constructor(runId: string) {
    super(`Run ${runId} was taken over by another process; this recovery stops here.`);
    this.name = 'RunTakenError';
    this.runId = runId;
  }
}

/**
 * A resumed run reached a step whose earlier result came with a workspace snapshot, and
 * this run was given no `snapshots` adapter to put that tree back with.
 *
 * Replaying the Output while silently leaving the workspace untouched would hand the
 * steps below it a tree that does not match the record they are being told about, so the
 * run stops instead. Resume with the same `snapshots` adapter the earlier run used.
 */
export class WorkspaceUnrestorableError extends Error {
  readonly stepName: string;

  constructor(stepName: string) {
    super(
      `Step "${stepName}" replays a result recorded with a workspace snapshot, but this ` +
        'run was given no `snapshots` adapter to restore it with. Pass the same ' +
        'WorkspaceSnapshots the earlier run used.',
    );
    this.name = 'WorkspaceUnrestorableError';
    this.stepName = stepName;
  }
}

/** A run id was handed to `resumeFrom`, but no adapter could load it. */
export class RunNotFoundError extends Error {
  readonly runId: string;

  constructor(runId: string) {
    super(`No run with id ${runId} could be read from storage.`);
    this.name = 'RunNotFoundError';
    this.runId = runId;
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
