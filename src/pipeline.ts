import type {
  ClaudeRunner,
  CacheAdapter,
  RunEvents,
  RunResult,
  Schema,
  StorageAdapter,
} from './types.ts';
import { PipelineInputError, isHalt } from './errors.ts';
import { Runner } from './runner.ts';
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
}

export interface Pipeline<I, O> {
  readonly name: string;
  readonly steps: readonly string[];
  run(options: RunOptions<I>): Promise<RunResult<O>>;
}

/**
 * Declares a pipeline. The returned object is reusable: one `run()` call is one Run,
 * against one input and one workspace.
 */
export function definePipeline<S extends Schema | undefined = undefined, O = unknown>(
  definition: PipelineDefinition<S, O>,
): Pipeline<S extends Schema<infer T> ? T : void, O> {
  type I = S extends Schema<infer T> ? T : void;

  return {
    name: definition.name,
    steps: definition.steps ?? [],
    async run(options: RunOptions<I>): Promise<RunResult<O>> {
      let input: unknown = options.input;
      if (definition.input) {
        try {
          input = definition.input.parse(options.input);
        } catch (error) {
          throw new PipelineInputError(definition.name, error);
        }
      }

      const runner = new Runner({
        pipeline: definition.name,
        runId: options.runId ?? crypto.randomUUID(),
        workspace: options.workspace ?? process.cwd(),
        input,
        model: options.model,
        declaredSteps: definition.steps ?? [],
        events: options.on ?? {},
        storage: options.storage,
        cache: options.cache,
        claude: options.claude,
        signal: options.signal,
      });

      await runner.start();
      const ctx = new RunContext(runner, input as never);

      try {
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
}
