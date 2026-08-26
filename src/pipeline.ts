import type { ClaudeRunner } from './claude.ts';
import type {
  InferInput,
  CacheAdapter,
  RunEvents,
  RunResult,
  RunStore,
  Schema,
  StorageAdapter,
  WorkspaceSnapshots,
} from './types.ts';
import { PipelineInputError, RunNotFoundError, isHalt } from './errors.ts';
import { Runner, type StepDefaults } from './runner.ts';
import { RunContext } from './context.ts';

export interface PipelineDefinition<S extends Schema | undefined, O> {
  name: string;
  /** Validated before the run starts; an invalid input never reaches a step. */
  input?: S;
  /**
   * Every step name this pipeline may run, in order. Optional, and used only to
   * record the steps a halt stopped the run from reaching — see ADR 0007.
   */
  steps?: readonly string[];
  /**
   * Step options this pipeline sets once for all of its steps, each still overridable
   * where a step disagrees.
   *
   * `onCrash` is here because a pipeline whose effects are uniformly repeatable — every
   * write a set-operation, every create an upsert — is stating a property of itself, and
   * repeating that at two dozen call sites is the kind of repetition that stops being
   * read (ADR 0009).
   */
  defaults?: StepDefaults;
  run(ctx: RunContext<S extends Schema<infer T> ? T : undefined>): Promise<O> | O;
}

export interface RunOptions<I> {
  input: I;
  /** The directory this run operates in. Defaults to `process.cwd()`. */
  workspace?: string;
  /** Default model for Claude steps. Also part of every cache key (ADR 0006). */
  model?: string;
  on?: RunEvents;
  storage?: StorageAdapter;
  /** Supplying a cache adapter is what makes `cache: {...}` steps cacheable. */
  cache?: CacheAdapter;
  /** Substitutes for real sessions. `fake()` returns one. */
  claude?: ClaudeRunner;
  signal?: AbortSignal;
  /** Overrides the generated run id, so a caller can correlate it with its own record. */
  runId?: string;
  /**
   * A previous run to resume. Every step whose work is unchanged replays that run's
   * result instead of doing it again, so a failure in step nine costs step nine rather
   * than the eight sessions before it.
   *
   * Take it from the `RunResult` the earlier `run()` returned, or from one you rebuilt
   * yourself. A run id may be given instead, which the storage adapter loads — that
   * needs an adapter implementing the optional read path (ADR 0009).
   */
  resumeFrom?: RunResult | string;
  /**
   * Captures the workspace after each step, so a resumed run continues against the tree
   * its replayed steps left behind rather than an untouched one (ADR 0011).
   */
  snapshots?: WorkspaceSnapshots;
  /**
   * How often to renew this run's lease, in milliseconds. Only has an effect when the
   * storage adapter records heartbeats; defaults to 15 seconds.
   */
  heartbeatMs?: number;
}

/** What `recover()` needs beyond the run it is picking up. */
export interface RecoverOptions<I>
  extends Omit<RunOptions<I>, 'input' | 'resumeFrom' | 'storage'> {
  /** The run to take over. Its input, workspace and model come from its own record. */
  runId: string;
  /** Must be able to read: recovery starts from a run this process never held. */
  storage: RunStore;
  /** Overrides the input the recovered run was started with. Rarely what you want. */
  input?: I;
}

export interface Pipeline<I, O> {
  readonly name: string;
  readonly steps: readonly string[];
  run(options: RunOptions<I>): Promise<RunResult<O>>;
  /**
   * Picks up a run that stopped — typically one a supervisor found through
   * `storage.resumable()` — and finishes it. Everything the run was started with is
   * read back from its own record, so the caller needs nothing but its id.
   */
  recover(options: RecoverOptions<I>): Promise<RunResult<O>>;
}

/**
 * Declares a pipeline. The returned object is reusable: one `run()` call is one Run,
 * against one input and one workspace.
 */
export function definePipeline<S extends Schema | undefined = undefined, O = unknown>(
  definition: PipelineDefinition<S, O>,
): Pipeline<S extends Schema ? InferInput<S> : void, O> {
  type I = S extends Schema ? InferInput<S> : void;

  const pipeline: Pipeline<I, O> = {
    name: definition.name,
    steps: definition.steps ?? [],

    async recover(options: RecoverOptions<I>): Promise<RunResult<O>> {
      const { runId, storage, ...rest } = options;
      const previous = await storage.readRun(runId);
      if (!previous) throw new RunNotFoundError(runId);
      return pipeline.run({
        ...rest,
        input: (options.input ?? previous.input) as I,
        workspace: options.workspace ?? previous.workspace,
        model: options.model ?? previous.model,
        storage,
        resumeFrom: previous,
      });
    },

    async run(options: RunOptions<I>): Promise<RunResult<O>> {
      let input: unknown = options.input;
      if (definition.input) {
        try {
          input = definition.input.parse(options.input);
        } catch (error) {
          throw new PipelineInputError(definition.name, error);
        }
      }

      const resumeFrom = await resolveResumeFrom(options);

      const runner = new Runner({
        pipeline: definition.name,
        runId: options.runId ?? crypto.randomUUID(),
        workspace: options.workspace ?? process.cwd(),
        input,
        model: options.model,
        declaredSteps: definition.steps ?? [],
        defaults: definition.defaults,
        events: options.on ?? {},
        storage: options.storage,
        cache: options.cache,
        claude: options.claude,
        signal: options.signal,
        resumeFrom,
        snapshots: options.snapshots,
        heartbeatMs: options.heartbeatMs,
      });

      const ctx = new RunContext(runner, input as never);

      try {
        // Inside the try: an adapter that throws on runStarted is a failed run like
        // any other, not an exception escaping a call documented to resolve.
        await runner.start();
        const output = await definition.run(ctx as never);
        return (await runner.finish({ status: 'completed', output })) as RunResult<O>;
      } catch (error) {
        if (isHalt(error)) {
          return (await runner.finish({
            status: 'halted',
            reason: error.reason,
          })) as RunResult<O>;
        }
        return (await runner.finish({ status: 'failed', error })) as RunResult<O>;
      }
    },
  };

  return pipeline;
}

/**
 * A run id is resolved through the storage adapter, which must be able to read.
 * Supplying the record directly stays the primary form — it needs no read path at all,
 * and the caller usually has it (ADR 0008, as amended by 0009).
 */
async function resolveResumeFrom(options: {
  resumeFrom?: RunResult | string;
  storage?: StorageAdapter;
}): Promise<RunResult | undefined> {
  if (typeof options.resumeFrom !== 'string') return options.resumeFrom;
  if (!options.storage?.readRun) {
    throw new Error(
      'resumeFrom was given a run id, but this run has no storage adapter that can read ' +
        'one back. Pass a RunResult instead, or use a store implementing readRun().',
    );
  }
  const found = await options.storage.readRun(options.resumeFrom);
  if (!found) throw new RunNotFoundError(options.resumeFrom);
  return found;
}
