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
import { HaltSignal, StepFailedError, isHalt, messageOf } from './errors.ts';
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
}

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
  /** The default runner, created once per run and only if a Claude step needs it. */
  claudeRunner?: ClaudeRunner;

  constructor(config: RunnerConfig) {
    this.config = config;
    this.replayable = new Map(
      (config.resumeFrom?.steps ?? [])
        .filter((step) => step.status === 'completed' && step.fingerprint !== undefined)
        .map((step) => [step.fingerprint!, step]),
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

  /** Fans one of Claude's messages out to storage and to the `message` event, verbatim. */
  async message(step: StepRecord, message: SDKMessage): Promise<void> {
    await this.storage((s) => s.messageAppended(step.id, message));
    await this.emit((e) => e.message?.(message, step));
  }

  async start(): Promise<void> {
    await this.storage((s) => s.runStarted(this.record));
    await this.emit((e) => e.runStarted?.(this.record));
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
    options: { timeout?: number } = {},
  ): Promise<T> {
    this.throwIfAborted();
    const name = step.name;
    // Set again here: a step held behind a concurrency limit was claimed earlier than
    // it actually began, and its duration should not count the wait.
    step.startedAt = Date.now();
    await this.storage((s) => s.stepStarted(step));
    await this.emit((e) => e.stepStarted?.(step));

    try {
      const result = await withTimeout(name, options.timeout, this.config.signal ?? NEVER_ABORTS, (signal) =>
        work(step, signal),
      );
      step.status = 'completed';
      if (result.output !== undefined) step.output = result.output;
      if (result.text !== undefined) step.text = result.text;
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
    if (outcome.status === 'halted') {
      this.record.haltReason = outcome.reason;
      await this.recordSkipped();
    } else if (outcome.status === 'failed') {
      this.record.error = messageOf(outcome.error);
    } else {
      this.record.output = outcome.output;
    }
    this.record.status = outcome.status as RunStatus;
    this.record.finishedAt = Date.now();
    this.record.durationMs = this.record.finishedAt - this.record.startedAt;

    const result: RunResult = { ...this.record, steps: this.steps };
    if (outcome.status === 'failed') result.cause = outcome.error;
    await this.storage((s) => s.runFinished(this.record));
    await this.emit((e) => e.runFinished?.(result));
    return result;
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
