import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type {
  CacheAdapter,
  ClaudeRunner,
  RunEvents,
  RunRecord,
  RunResult,
  RunStatus,
  StepKind,
  StepRecord,
  StorageAdapter,
} from './types.ts';
import type { WorkspaceSnapshots } from './types.ts';
import { HaltSignal, RunTakenError, StepFailedError, isHalt, messageOf } from './errors.ts';
import { NEVER_ABORTS, withTimeout } from './timeout.ts';

/** Everything a run needs that is not specific to one step kind. */
export interface RunnerConfig {
  pipeline: string;
  runId: string;
  workspace: string;
  input: unknown;
  model?: string;
  declaredSteps: readonly string[];
  events: RunEvents;
  storage?: StorageAdapter;
  cache?: CacheAdapter;
  claude?: ClaudeRunner;
  signal?: AbortSignal;
  /** A previous run whose completed steps this run may replay instead of redoing. */
  resumeFrom?: RunResult;
  /** Captures the workspace after each step, and restores it on resume (ADR 0011). */
  snapshots?: WorkspaceSnapshots;
  /** How often to renew the run's lease. Only used if the adapter can record one. */
  heartbeatMs?: number;
}

/** Default lease renewal interval. A supervisor's `staleMs` should be a few of these. */
export const HEARTBEAT_MS = 15_000;

/**
 * Owns one run: step ordering, records, lifecycle events and the write-through to
 * storage. Step kinds sit on top of `execute()`; none of them decide what runs next.
 */
export class Runner {
  readonly config: RunnerConfig;
  readonly record: RunRecord;
  readonly steps: StepRecord[] = [];
  private nextIndex = 0;
  /** Completed steps of the run being resumed, by fingerprint. Empty when not resuming. */
  private readonly replayable: Map<string, StepRecord>;
  /**
   * Steps the resumed run left `running`: a process died holding them, and whether
   * their work took effect is unknown (ADR 0009).
   */
  private readonly indeterminate: Map<string, StepRecord>;
  /**
   * The snapshot this run owes the workspace: the state the last replayed step left
   * behind, not yet restored because nothing has needed to do real work yet.
   */
  private owedSnapshot?: string;
  /**
   * The restore currently in progress, if any. A concurrent group's members all reach
   * `settle()` at once, and every one of them must wait for the tree to be rewritten —
   * not just whichever got there first.
   */
  private restoring?: Promise<void>;
  private heartbeat?: ReturnType<typeof setInterval>;
  /** The default runner, created once per run and only if a Claude step needs it. */
  claudeRunner?: ClaudeRunner;

  constructor(config: RunnerConfig) {
    this.config = config;
    const prior = (config.resumeFrom?.steps ?? []).filter((step) => step.fingerprint !== undefined);
    this.replayable = new Map(
      prior.filter((step) => step.status === 'completed').map((step) => [step.fingerprint!, step]),
    );
    this.indeterminate = new Map(
      prior.filter((step) => step.status === 'running').map((step) => [step.fingerprint!, step]),
    );
    this.record = {
      id: config.runId,
      pipeline: config.pipeline,
      status: 'running',
      workspace: config.workspace,
      input: config.input,
      model: config.model,
      startedAt: Date.now(),
    };
  }

  /** Outputs of every step completed so far, in order. Feeds cache keys (ADR 0006). */
  upstreamOutputs(): { name: string; output: unknown }[] {
    return this.steps
      .filter((s) => s.status === 'completed')
      .map((s) => ({ name: s.name, output: s.output ?? s.text ?? null }));
  }

  /**
   * The completed step from the run being resumed that did this exact work, if there
   * is one.
   *
   * Matching on the fingerprint is what makes resume safe to chain: a step's
   * fingerprint covers every upstream Output, so a step that genuinely re-runs and
   * produces something different breaks the match for everything after it.
   */
  replay(fingerprint: string): StepRecord | undefined {
    return this.replayable.get(fingerprint);
  }

  /**
   * The step of the resumed run that was in flight when its process died, if this
   * exact work is it. Never a step that finished — those replay.
   */
  inFlight(fingerprint: string): StepRecord | undefined {
    return this.indeterminate.get(fingerprint);
  }

  /**
   * Carries a replayed step's workspace snapshot forward, and makes it the state the
   * run owes the workspace before anything does real work again.
   */
  noteReplayed(step: StepRecord, prior: StepRecord): void {
    step.replayed = true;
    if (prior.snapshot === undefined) return;
    step.snapshot = prior.snapshot;
    this.owedSnapshot = prior.snapshot;
  }

  /**
   * Puts the workspace back to where the replayed steps left it, if that is still
   * owed. Called once, at the first moment real work is about to happen, rather than
   * after every replayed step: the intermediate states are never observed.
   */
  async restoreWorkspace(signal: AbortSignal, step: StepRecord): Promise<void> {
    // A restore already under way is the one to wait for. Clearing `owedSnapshot`
    // before awaiting would let a sibling step start work on a tree mid-rewrite.
    if (this.restoring) return this.restoring;

    const snapshot = this.owedSnapshot;
    if (snapshot === undefined || !this.config.snapshots) return;
    this.owedSnapshot = undefined;
    this.restoring = Promise.resolve(
      this.config.snapshots.restore({
        workspace: this.config.workspace,
        runId: this.record.id,
        step,
        snapshot,
        signal,
      }),
    );
    try {
      await this.restoring;
    } finally {
      this.restoring = undefined;
    }
  }

  /** Fans one of Claude's messages out to storage and to the `message` event, verbatim. */
  async message(step: StepRecord, message: SDKMessage): Promise<void> {
    await this.storage((s) => s.messageAppended(step.id, message));
    await this.emit((e) => e.message?.(message, step));
  }

  async start(): Promise<void> {
    await this.storage((s) => s.runStarted(this.record));
    await this.emit((e) => e.runStarted?.(this.record));

    // A run left `running` by a dead process is offered to supervisors until something
    // takes it over. This run is that something — and the claim has to be exclusive:
    // two supervisors polling the same stale run would otherwise both finish it, and
    // duplicate exactly the External effects ADR 0009 exists to protect.
    const previous = this.config.resumeFrom;
    if (previous?.status === 'running' && previous.id !== this.record.id) {
      const adapter = this.config.storage;
      if (adapter?.runSuperseded) {
        const won = await adapter.runSuperseded(previous.id, this.record.id);
        // An adapter that reports nothing cannot arbitrate, and is trusted; one that
        // says it lost has told us another process is already doing this work.
        if (won === false) throw new RunTakenError(previous.id);
      }
    }

    if (this.config.storage?.heartbeat) {
      const every = this.config.heartbeatMs ?? HEARTBEAT_MS;
      this.heartbeat = setInterval(() => {
        void Promise.resolve(this.config.storage!.heartbeat!(this.record.id, Date.now())).catch(
          (error) => report(this.config.events, error),
        );
      }, every);
      // A lease must not be the reason a process stays alive.
      this.heartbeat.unref?.();
      await this.storage((s) => s.heartbeat!(this.record.id, Date.now()));
    }
  }

  /**
   * Claims a step's place in the run, before any of its work starts.
   *
   * Separate from `execute` so a concurrent group can claim all of its places up
   * front and be recorded in the order it was declared, rather than in whatever order
   * its members happened to finish.
   */
  beginStep(name: string, kind: StepKind): StepRecord {
    const step: StepRecord = {
      id: crypto.randomUUID(),
      runId: this.record.id,
      index: this.nextIndex++,
      name,
      kind,
      status: 'running',
      startedAt: Date.now(),
    };
    this.steps.push(step);
    return step;
  }

  /**
   * Runs one step, recording it whatever happens. `work` receives the live record so
   * a step kind can annotate it (exit code, session id, cache hit) before it finishes,
   * and the signal it must do its work under — the run's, narrowed by this step's
   * `timeout` when it declared one.
   */
  async execute<T>(
    step: StepRecord,
    work: (step: StepRecord, signal: AbortSignal) => Promise<{ value: T; output?: unknown; text?: string }>,
    options: { timeout?: number; identify?: () => Promise<string | undefined> } = {},
  ): Promise<T> {
    this.throwIfAborted();
    const name = step.name;
    // Set again here: a step held behind a concurrency limit was claimed earlier than
    // it actually began, and its duration should not count the wait.
    step.startedAt = Date.now();

    // The fingerprint is settled before the step is announced, so the record written at
    // the moment work begins says what that work is. A process killed a line later
    // leaves a row a later run can recognise instead of an anonymous `running` one
    // (ADR 0009).
    try {
      if (options.identify) step.fingerprint = await options.identify();
    } catch (error) {
      // The identity could not be computed, so no work will happen — but the step has
      // already claimed its place, and must not be left looking as though it might be
      // running somewhere.
      await this.announce(step);
      step.status = 'failed';
      step.error = messageOf(error);
      await this.finishStep(step);
      throw new StepFailedError(name, error);
    }

    await this.announce(step);

    try {
      const result = await withTimeout(name, options.timeout, this.config.signal ?? NEVER_ABORTS, (signal) =>
        work(step, signal),
      );
      step.status = 'completed';
      if (result.output !== undefined) step.output = result.output;
      if (result.text !== undefined) step.text = result.text;
      // Before the step is recorded as finished, so a snapshot that cannot be taken
      // fails the step through the ordinary path rather than after it.
      await this.captureSnapshot(step);
      await this.finishStep(step);
      return result.value;
    } catch (error) {
      if (isHalt(error)) {
        // A halt is not this step's failure; it is the run ending successfully.
        step.status = 'completed';
        await this.finishStep(step);
        throw error;
      }
      step.status = 'failed';
      step.error = messageOf(error);
      await this.finishStep(step);
      throw error instanceof StepFailedError ? error : new StepFailedError(name, error);
    }
  }

  private async announce(step: StepRecord): Promise<void> {
    await this.storage((s) => s.stepStarted(step));
    await this.emit((e) => e.stepStarted?.(step));
  }

  /** Records the declared steps a halt stopped the run from reaching. */
  private async recordSkipped(): Promise<void> {
    const ran = new Set(this.steps.map((s) => s.name));
    for (const name of this.config.declaredSteps) {
      if (ran.has(name)) continue;
      const now = Date.now();
      const step: StepRecord = {
        id: crypto.randomUUID(),
        runId: this.record.id,
        index: -1,
        name,
        kind: 'code',
        status: 'skipped',
        startedAt: now,
        finishedAt: now,
        durationMs: 0,
      };
      this.steps.push(step);
      await this.storage((s) => s.stepStarted(step));
      // Emitted as a pair, so every stepFinished a listener sees has a stepStarted
      // before it. Both carry status 'skipped', which is how a listener tells.
      await this.emit((e) => e.stepStarted?.(step));
      await this.storage((s) => s.stepFinished(step));
      await this.emit((e) => e.stepFinished?.(step));
    }
  }

  async finish(outcome:
    | { status: 'completed'; output: unknown }
    | { status: 'halted'; reason: string }
    | { status: 'failed'; error: unknown },
  ): Promise<RunResult> {
    clearInterval(this.heartbeat);

    // Recorded before the deferred restore below, which may yet fail the run: a run that
    // halted did halt, and its reason and its skipped steps are the record of that
    // whatever happens in the epilogue.
    if (outcome.status === 'halted') {
      this.record.haltReason = outcome.reason;
      await this.recordSkipped();
    } else if (outcome.status === 'failed') {
      this.record.error = messageOf(outcome.error);
    } else {
      this.record.output = outcome.output;
    }
    let status: RunStatus = outcome.status;

    // A run whose every step replayed never needed the workspace and so never restored
    // it. The caller is still owed a tree that matches the record it is handed. Only a
    // replayed step can owe one, so there is always a last step to attribute it to.
    if (this.owedSnapshot !== undefined) {
      try {
        await this.restoreWorkspace(this.config.signal ?? NEVER_ABORTS, this.steps.at(-1)!);
      } catch (error) {
        // A run that cannot leave the workspace where it says it did has not completed.
        if (status === 'failed') {
          report(this.config.events, error);
        } else {
          status = 'failed';
          this.record.error = messageOf(error);
          outcome = { status: 'failed', error };
        }
      }
    }
    this.record.status = status;
    this.record.finishedAt = Date.now();
    this.record.durationMs = this.record.finishedAt - this.record.startedAt;

    const result: RunResult = { ...this.record, steps: this.steps };
    if (outcome.status === 'failed') result.cause = outcome.error;
    await this.storage((s) => s.runFinished(this.record));
    await this.emit((e) => e.runFinished?.(result));
    return result;
  }

  /**
   * Records the workspace as this step left it, so a later run that replays this step
   * can put the tree back (ADR 0011). A replayed step already carries its predecessor's
   * snapshot, and a `value` step never touches the workspace.
   */
  private async captureSnapshot(step: StepRecord): Promise<void> {
    if (!this.config.snapshots || step.replayed || step.kind === 'value') return;
    step.snapshot = await this.config.snapshots.capture({
      workspace: this.config.workspace,
      runId: this.record.id,
      step,
      signal: this.config.signal ?? NEVER_ABORTS,
    });
  }

  private async finishStep(step: StepRecord): Promise<void> {
    step.finishedAt = Date.now();
    step.durationMs = step.finishedAt - step.startedAt;
    await this.storage((s) => s.stepFinished(step));
    await this.emit((e) => e.stepFinished?.(step));
  }

  throwIfAborted(): void {
    if (this.config.signal?.aborted) {
      throw new Error(`Run ${this.record.id} was aborted`);
    }
  }

  /** Storage failures are the consumer's to see, so they propagate. */
  private async storage(fn: (adapter: StorageAdapter) => Promise<void> | void): Promise<void> {
    if (this.config.storage) await fn(this.config.storage);
  }

  /** A listener that throws must not take the run down with it — including this one. */
  async emit(fn: (events: RunEvents) => void | Promise<void>): Promise<void> {
    try {
      await fn(this.config.events);
    } catch (error) {
      report(this.config.events, error);
    }
  }
}

function report(events: RunEvents, error: unknown): void {
  if (!events.error) {
    console.error('[claude-code-pipelines-sdk] event listener threw:', error);
    return;
  }
  try {
    events.error(error);
  } catch (reportingError) {
    console.error(
      '[claude-code-pipelines-sdk] the error listener threw while reporting:',
      reportingError,
    );
    console.error('[claude-code-pipelines-sdk] the error it was reporting:', error);
  }
}

export { HaltSignal };
