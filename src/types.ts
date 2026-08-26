import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

/**
 * Structural view of a Zod schema. Declared structurally so the SDK's own types
 * do not depend on a particular Zod build; `zod` v4 is a peer dependency and its
 * schemas satisfy this shape.
 */
export interface Schema<Output = unknown> {
  parse(data: unknown): Output;
}

/** What a schema produces — `ctx.input`, and a Claude step's Output. */
export type Infer<S> = S extends Schema<infer T> ? T : never;

/**
 * What a schema accepts. Read off the Standard Schema properties Zod exposes, so a
 * field with a `.default()` stays optional in the value you pass to `run()` while
 * `ctx.input` still sees it filled in.
 */
export type InferInput<S> = S extends {
  readonly '~standard': { readonly types?: { readonly input: infer I } | undefined };
}
  ? I
  : Infer<S>;

/**
 * How a step did its work. `value` is a recorded non-deterministic value —
 * `ctx.now()`, `ctx.random()`, `ctx.uuid()` — kept apart from work so a run's history
 * reads as the work it did (ADR 0010).
 */
export type StepKind = 'claude' | 'command' | 'code' | 'value';

/**
 * `skipped` is reserved for steps a halt stopped the run from reaching; a branch
 * simply not taken produces no record at all.
 */
export type StepStatus = 'running' | 'completed' | 'failed' | 'skipped';

/**
 * `superseded` is a run another run recovered: it was left `running` by a process that
 * died, and a later run took over its work (ADR 0009).
 */
export type RunStatus = 'running' | 'completed' | 'halted' | 'failed' | 'superseded';

/** How a step resolved against an indeterminate step of the run being resumed. */
export type Recovery = 'reconciled' | 'rerun';

/** What a step does when it matches a step a crash left in flight (ADR 0009). */
export type CrashPolicy = 'rerun' | 'fail';

/** What a run wrote about one step. Handed to the storage adapter and to `on` events. */
export interface StepRecord {
  id: string;
  runId: string;
  /** Position in the run, in execution order. `-1` for steps recorded as skipped. */
  index: number;
  name: string;
  kind: StepKind;
  status: StepStatus;
  startedAt: number;
  finishedAt?: number;
  durationMs?: number;
  /** The schema-validated Output of a Claude step, or a command/code step's value. */
  output?: unknown;
  /** Final assistant text of a Claude step. */
  text?: string;
  error?: string;
  exitCode?: number;
  sessionId?: string;
  /** How many attempts the step took, including the successful one. */
  attempts?: number;
  cacheKey?: string;
  cacheHit?: boolean;
  /**
   * Identity of this step's work: what it declared, its declared input files, the
   * pipeline input, the model, and every upstream Output. Computed for every step,
   * cacheable or not, because it is also how a later run decides whether this step's
   * result still stands. A cacheable step uses the same value as its `cacheKey`.
   */
  fingerprint?: string;
  /** True when this step's result came from the run being resumed rather than from work. */
  replayed?: boolean;
  /**
   * Set when this step matched a step a crash left `running`, and says how it was
   * resolved: `reconciled` means the outside world confirmed the effect had already
   * landed, `rerun` means the work was simply done again.
   */
  recovered?: Recovery;
  /** Id of the workspace snapshot taken after this step completed (ADR 0011). */
  snapshot?: string;
}

/** What a run wrote about itself. */
export interface RunRecord {
  id: string;
  pipeline: string;
  status: RunStatus;
  workspace: string;
  input: unknown;
  model?: string;
  startedAt: number;
  finishedAt?: number;
  durationMs?: number;
  /** The value the pipeline's `run` returned. Absent when halted or failed. */
  output?: unknown;
  haltReason?: string;
  error?: string;
}

/** A finished run: its record plus every step record, in order. */
export interface RunResult<O = unknown> extends RunRecord {
  output?: O;
  steps: StepRecord[];
  /** The error that failed the run, unserialised. Absent unless `status` is `failed`. */
  cause?: unknown;
}

/**
 * Live progress. The application watching a run is the process running it, so it
 * subscribes here rather than reading the store.
 *
 * A listener that throws does not fail the run; the error is reported to `error`
 * if one is supplied, and otherwise written to stderr.
 */
export interface RunEvents {
  runStarted?(run: RunRecord): void | Promise<void>;
  stepStarted?(step: StepRecord): void | Promise<void>;
  /** Claude's `SDKMessage`, verbatim, with the step that produced it. */
  message?(message: SDKMessage, step: StepRecord): void | Promise<void>;
  stepFinished?(step: StepRecord): void | Promise<void>;
  runFinished?(run: RunResult): void | Promise<void>;
  /** Reports a listener that threw. */
  error?(error: unknown): void;
}

/**
 * A sink for a run's history. The required half is write-only and the SDK never deletes:
 * retention belongs to whoever implements this.
 *
 * The optional half is what makes runs recoverable by a process that was not there when
 * they died (ADR 0009). An adapter that implements none of it is still a valid adapter.
 */
export interface StorageAdapter {
  runStarted(run: RunRecord): Promise<void> | void;
  stepStarted(step: StepRecord): Promise<void> | void;
  messageAppended(stepId: string, message: SDKMessage): Promise<void> | void;
  stepFinished(step: StepRecord): Promise<void> | void;
  runFinished(run: RunRecord): Promise<void> | void;

  /**
   * Rebuild a run, so `resumeFrom` can be a run id. Returns `undefined` for a run this
   * adapter has never seen.
   */
  readRun?(runId: string): Promise<RunResult | undefined> | RunResult | undefined;
  /**
   * Runs still marked `running` whose heartbeat has gone quiet — the ones whose owner
   * is gone and whose work may be taken. What a supervisor polls.
   */
  resumable?(query?: ResumableQuery): Promise<RunRecord[]> | RunRecord[];
  /** Renews a run's lease. Written on an interval for as long as the run is alive. */
  heartbeat?(runId: string, at: number): Promise<void> | void;
  /**
   * Marks a run as taken over by another, so a supervisor stops offering it.
   *
   * Return `false` to say the takeover was lost — another process got there first — and
   * the run stops rather than duplicating its remaining effects. An adapter that cannot
   * arbitrate returns nothing, and is trusted.
   */
  runSuperseded?(previous: string, by: string): Promise<boolean | void> | boolean | void;
}

export interface ResumableQuery {
  /** Only runs of this pipeline. */
  pipeline?: string;
  /** How long a run may go without a heartbeat before it counts as abandoned. */
  staleMs?: number;
  limit?: number;
}

/**
 * A `StorageAdapter` that also reads. `pipeline.recover()` needs one; `run()` needs one
 * only when `resumeFrom` is a run id rather than a record.
 */
export interface RunStore extends StorageAdapter {
  readRun(runId: string): Promise<RunResult | undefined> | RunResult | undefined;
  resumable(query?: ResumableQuery): Promise<RunRecord[]> | RunRecord[];
  heartbeat(runId: string, at: number): Promise<void> | void;
}

/**
 * Captures and restores the workspace, so a resumed run continues against the tree its
 * replayed steps left behind rather than an untouched one (ADR 0011).
 */
export interface WorkspaceSnapshots {
  /**
   * Record the workspace as it stands. The returned id is stored on the step; returning
   * `undefined` means there was nothing worth capturing.
   */
  capture(context: SnapshotContext): Promise<string | undefined> | string | undefined;
  /** Put the workspace back to a captured state. Destructive by construction. */
  restore(context: SnapshotContext & { snapshot: string }): Promise<void> | void;
}

export interface SnapshotContext {
  workspace: string;
  runId: string;
  step: StepRecord;
  signal: AbortSignal;
}

/** A small keyed store. Separate from storage because caching must read back what it wrote. */
export interface CacheAdapter {
  get(key: string): Promise<unknown | undefined> | unknown | undefined;
  set(key: string, value: unknown): Promise<void> | void;
}

/** Opt-in caching for one step. Steps are never cacheable by default. */
export interface CacheOptions {
  /**
   * Files whose contents the step depends on, relative to the workspace.
   * Glob patterns are expanded. The key also covers everything in ADR 0006.
   */
  inputs?: string[];
}

/** Options common to every step kind. */
export interface StepOptionsBase {
  name?: string;
  cache?: CacheOptions;
  /**
   * Fail the step after this many milliseconds. Enforced by the runner, so it bounds
   * every kind alike — a command step's process is killed, and a code step that never
   * looks at its signal still fails on time.
   */
  timeout?: number;
  /**
   * What to do when this step matches a step a crash left in flight, and nothing else
   * could settle whether its work landed (ADR 0009).
   *
   * Defaults by kind: `'rerun'` for Claude and command steps, which act on a workspace
   * that snapshots restore, and `'fail'` for code steps, which are where External
   * effects live. A command that reaches outside the workspace should say `'fail'`.
   */
  onCrash?: CrashPolicy;
}

/**
 * Options for `ctx.step`. This is where External effects live, so it is the only kind
 * that can be told how to find out whether its effect already landed.
 */
export interface CodeStepOptions<T = unknown> {
  timeout?: number;
  onCrash?: CrashPolicy;
  /**
   * Asks the outside world whether this step's effect already happened, when a crash
   * left it in flight (ADR 0009).
   *
   * Called only on a resumed run, and only for a step that matched an indeterminate
   * step of the run being resumed. Return the effect's result to adopt it — the merge
   * request that turns out to already exist — or `undefined` to say it did not happen,
   * in which case the step runs normally. Either way the question is settled, and
   * `onCrash` never applies.
   *
   * Because `undefined` is the answer "it did not happen", a step whose own value is
   * `undefined` cannot be reconciled: give it something to return.
   */
  reconcile?(signal: AbortSignal): Promise<T | undefined> | T | undefined;
}
