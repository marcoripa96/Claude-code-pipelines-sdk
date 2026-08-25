import type { Options as AgentOptions } from '@anthropic-ai/claude-agent-sdk';
import type { ClaudeDefaults } from './runners/claude.ts';
import { consoleReporter } from './reporter.ts';
import { Runtime, resolveStateDir } from './runtime.ts';
import { validateOutput } from './schema.ts';
import type {
  EventListener,
  FailedRunResult,
  NodeChain,
  PipelineEvent,
  RunResult,
  RunSummary,
  StepContext,
} from './types.ts';

/** Everything the run body can reach: the chaining surface plus run metadata. */
export interface PipelineContext<TInput> extends NodeChain {
  readonly input: TInput;
  readonly runId: string;
  readonly cwd: string;
  /** Aborted when the run ends. Pass it to your own long-running work. */
  readonly signal: AbortSignal;
  log(message: string): void;
  /** Reported Claude cost so far in this run. */
  cost(): number;
}

/**
 * Anything that can describe a pipeline's input: a Zod schema, any Standard
 * Schema, or the type-only carrier returned by `inputType<T>()`.
 */
export type InputSchema =
  | { readonly '~standard': { types?: { input: unknown; output: unknown } | undefined; validate: (value: unknown) => unknown } }
  | { parse: (value: unknown) => unknown };

/**
 * The value `run()` accepts — a schema's *input* side, so fields with defaults
 * stay optional at the call site.
 */
export type InferInput<S> = S extends undefined
  ? void
  : S extends { readonly '~standard': { types?: { input: infer I } | undefined } }
    ? I
    : S extends { parse: (value: unknown) => infer O }
      ? O
      : unknown;

/** The value `ctx.input` holds — a schema's *output* side, after defaults are applied. */
export type InferValidated<S> = S extends undefined
  ? void
  : S extends { readonly '~standard': { types?: { output: infer O } | undefined } }
    ? O
    : S extends { parse: (value: unknown) => infer O }
      ? O
      : unknown;

/**
 * Declare a pipeline's input type without a validation library.
 *
 * `input: inputType<{ base: string }>()` types `ctx.input` and `run()` while
 * validating nothing — use a real schema when the input crosses a boundary.
 */
export function inputType<T>(): {
  readonly '~standard': { types?: { input: T; output: T }; validate: (value: unknown) => { value: T } };
} {
  return { '~standard': { validate: (value) => ({ value: value as T }) } };
}

export interface PipelineConfig<S extends InputSchema | undefined, TOutput> {
  name: string;
  /** Describes and (for a real schema) validates the value passed to `run()`. */
  input?: S;
  /** Working directory for shell commands and Claude nodes. Default `process.cwd()`. */
  cwd?: string;
  /** Where the cache, journals and run summaries live. Default `.pipeline`. */
  stateDir?: string;
  /** Max nodes in flight. A number applies to every kind. */
  concurrency?: number | Partial<{ exec: number; claude: number; step: number }>;
  /** Defaults inherited by every `claude` node. */
  claude?: ClaudeDefaults & { tools?: AgentOptions['tools'] };
  /** Print progress to stderr. Default true when stderr is a TTY. */
  reporter?: boolean | EventListener;
  /** The body of the pipeline. Plain code — `await` is the dependency edge. */
  run: (ctx: PipelineContext<InferValidated<S>>) => Promise<TOutput> | TOutput;
}

export interface RunOptions {
  /** Replay the successful nodes of a previous run, re-executing from the failure. */
  resumeFrom?: string;
  /** Ignore the cache for these node names and re-execute them. */
  force?: string[];
  /** Disable the cross-run cache for this run. */
  noCache?: boolean;
  /** Cancel the whole run. */
  signal?: AbortSignal;
  /** Extra event listener for this run only. */
  onEvent?: EventListener;
}

export interface Pipeline<TInput, TOutput> {
  readonly name: string;
  /** Run the pipeline. Throws on failure, with `error.run` carrying the summary. */
  run(input: TInput, options?: RunOptions): Promise<RunResult<TOutput>>;
  /** Run the pipeline and return a discriminated result instead of throwing. */
  tryRun(input: TInput, options?: RunOptions): Promise<RunResult<TOutput> | FailedRunResult>;
  /** Subscribe to run and node events. Returns an unsubscribe function. */
  on(listener: EventListener): () => void;
}

export class PipelineRunError extends Error {
  constructor(readonly run: FailedRunResult, cause: Error) {
    super(`pipeline "${run.pipeline}" failed: ${cause.message}`);
    this.name = 'PipelineRunError';
    this.cause = cause;
    this.stack = cause.stack;
  }
}

/**
 * Define a pipeline.
 *
 * The body is ordinary async code: `await` expresses a dependency, `Promise.all`
 * expresses a fan-out, and every node result can spawn its children directly, so
 * the graph is whatever the code says it is.
 */
export function definePipeline<S extends InputSchema | undefined = undefined, TOutput = void>(
  config: PipelineConfig<S, TOutput>,
): Pipeline<InferInput<S>, TOutput> {
  type TInput = InferInput<S>;
  type TValidated = InferValidated<S>;
  const listeners: EventListener[] = [];
  const cwd = config.cwd ?? process.cwd();

  const tryRun = async (input: TInput, options: RunOptions = {}): Promise<RunResult<TOutput> | FailedRunResult> => {
    const runListeners = [...listeners];
    if (options.onEvent) runListeners.push(options.onEvent);

    const reporter = resolveReporter(config.reporter);
    if (reporter) runListeners.push(reporter);

    const runtime = new Runtime({
      pipeline: config.name,
      cwd,
      stateDir: resolveStateDir(cwd, config.stateDir ?? '.pipeline'),
      concurrency: normalizeConcurrency(config.concurrency),
      claudeDefaults: config.claude ?? {},
      useCache: !options.noCache,
      resumeFrom: options.resumeFrom,
      force: new Set(options.force ?? []),
      listeners: runListeners,
      signal: options.signal,
    });

    await runtime.init();
    runtime.emit({ type: 'run:start', runId: runtime.runId, pipeline: config.name, input });

    let value: TOutput | undefined;
    let error: Error | undefined;
    try {
      // Input validation happens inside the run so a bad input is reported the
      // same way any other failure is, rather than escaping `tryRun`.
      const validated = config.input
        ? ((await validateOutput(config.input as never, input)) as TValidated)
        : (input as unknown as TValidated);

      const ctx: PipelineContext<TValidated> = {
        ...runtime.chain([]),
        input: validated,
        runId: runtime.runId,
        cwd,
        signal: runtime.signal,
        log: (message) => runtime.emit({ type: 'log', message }),
        cost: () => runtime.costUsd,
      };

      value = await config.run(ctx);
    } catch (caught) {
      error = caught instanceof Error ? caught : new Error(String(caught));
    } finally {
      await runtime.finish();
    }

    const base: RunSummary = {
      runId: runtime.runId,
      pipeline: config.name,
      startedAt: runtime.startedAt,
      durationMs: Date.now() - runtime.startedAt,
      ok: error === undefined,
      costUsd: runtime.costUsd,
      nodes: [...runtime.nodes.values()],
      graph: { nodes: [...runtime.nodes.values()], edges: runtime.edges },
    };

    const summary = error === undefined
      ? ({ ...base, ok: true, value: value as TOutput } satisfies RunResult<TOutput>)
      : ({ ...base, ok: false, error } satisfies FailedRunResult);

    runtime.emit({ type: 'run:end', summary: base });
    await runtime.writeSummary(base);
    return summary;
  };

  return {
    name: config.name,
    tryRun,
    async run(input, options) {
      const result = await tryRun(input, options);
      if (!result.ok) throw new PipelineRunError(result, result.error);
      return result;
    },
    on(listener) {
      listeners.push(listener);
      return () => {
        const index = listeners.indexOf(listener);
        if (index !== -1) listeners.splice(index, 1);
      };
    },
  };
}

function normalizeConcurrency(
  concurrency: PipelineConfig<undefined, unknown>['concurrency'],
): { exec: number; claude: number; step: number } {
  // Claude nodes default to a lower cap than shell nodes: each one is a separate
  // CLI process with its own model traffic.
  const defaults = { exec: 8, claude: 3, step: Infinity };
  if (concurrency === undefined) return defaults;
  if (typeof concurrency === 'number') return { exec: concurrency, claude: concurrency, step: concurrency };
  return { ...defaults, ...concurrency };
}

function resolveReporter(reporter: PipelineConfig<undefined, unknown>['reporter']): EventListener | undefined {
  if (typeof reporter === 'function') return reporter;
  const enabled = reporter ?? Boolean(process.stderr.isTTY);
  if (!enabled) return undefined;
  return consoleReporter();
}

export type { PipelineEvent, StepContext };
