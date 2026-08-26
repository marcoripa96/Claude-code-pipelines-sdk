import type { Runner } from './runner.ts';
import type {
  CacheOptions,
  CodeStepOptions,
  CrashPolicy,
  Infer,
  Schema,
  StepRecord,
} from './types.ts';
import type { CommandHandle, CommandOutcome, CommandStepOptions } from './command.ts';
import { assertCommandOk, commandHandle, runCommand } from './command.ts';
import { ClaudeStepError, HaltSignal, IndeterminateStepError, isHalt } from './errors.ts';
import type { ClaudeHandle, ClaudeRequest, ClaudeStepOptions } from './claude.ts';
import { createClaudeRunner } from './claude.ts';
import { computeCacheKey } from './cache.ts';
import { Limiter } from './limiter.ts';

/** One step's entry in the cache: the same key, for reading and for writing. */
interface CacheSlot {
  get(): Promise<unknown | undefined>;
  set(value: unknown): Promise<void>;
}

/** An answer `settle()` found, and which of the three places it came from. */
interface Settled {
  value: unknown;
  from: 'replay' | 'reconcile' | 'cache';
}

/**
 * What a pipeline's `run` function is handed. Every method here records a step;
 * none of them decide what runs next — that is the pipeline code's job.
 */
export class RunContext<I = unknown> {
  /** The validated pipeline input. */
  readonly input: I;
  /** The directory this run operates in. */
  readonly workspace: string;
  readonly runId: string;
  /** @internal */
  readonly runner: Runner;
  /** Position counter for `now()`/`random()`/`uuid()`, shared across all three. */
  private values = 0;

  constructor(runner: Runner, input: I) {
    this.runner = runner;
    this.input = input;
    this.workspace = runner.config.workspace;
    this.runId = runner.record.id;
  }

  /**
   * Runs arbitrary code as a step. This is where External effects belong.
   *
   * `fn` is handed the step's abort signal; pass it to your own long-running work so
   * a `timeout` or a cancelled run can stop it rather than merely stop waiting.
   */
  step<T>(
    name: string,
    fn: (signal: AbortSignal) => T | Promise<T>,
    options: CodeStepOptions<T> = {},
  ): Promise<T> {
    return this.runner.execute(
      this.runner.beginStep(name, 'code'),
      async (record, signal) => {
        const settled = await this.settle(record, (prior) => prior.output, {
          // A code step is where External effects live, so a repeat is the expensive
          // mistake: it stops and asks unless told how to find out (ADR 0009).
          onCrash: this.onCrash(options.onCrash, 'fail'),
          reconcile: options.reconcile,
          signal,
        });
        if (settled) return { value: settled.value as T, output: settled.value };

        const value = await fn(signal);
        return { value, output: value };
      },
      {
        timeout: options.timeout,
        // A code step's identity includes its source — edit the function and it runs
        // again. A resumed run must not post the comment or open the pull request twice.
        identify: () => this.fingerprint(name, 'code', undefined, { source: fn.toString() }),
      },
    );
  }

  /**
   * The current time, recorded as a step.
   *
   * A resumed run re-executes the pipeline's code between steps, so a clock read in the
   * driver goes wrong in one of two ways: it reaches a step's declaration and re-runs
   * everything below it, or it stays in a closure and is silently discarded on replay.
   * Reading it here records the answer once (ADR 0010).
   */
  now(): Promise<number> {
    return this.recordedValue('now', () => Date.now());
  }

  /** A random number, recorded as a step, for the reason `now()` is. */
  random(): Promise<number> {
    return this.recordedValue('random', () => Math.random());
  }

  /** A fresh UUID, recorded as a step, for the reason `now()` is. */
  uuid(): Promise<string> {
    return this.recordedValue('uuid', () => crypto.randomUUID());
  }

  /**
   * @internal One recorded non-deterministic value.
   *
   * Named by position across all three, because a label at every call site is the
   * friction that makes people read the clock directly instead. Inserting a call above
   * another renumbers it, and the renumbered step re-runs — the same conservatism as
   * ADR 0006, and re-reading a clock costs nothing.
   */
  private recordedValue<T>(kind: string, produce: () => T): Promise<T> {
    const name = `${kind}#${++this.values}`;
    return this.runner.execute(
      this.runner.beginStep(name, 'value'),
      async (record, signal) => {
        // A recorded value is a number or a string; redoing one costs nothing, so it
        // never asks and never consults the pipeline's default.
        const settled = await this.settle(record, (prior) => prior.output, {
          onCrash: 'rerun',
          signal,
        });
        if (settled) return { value: settled.value as T, output: settled.value };
        const value = produce();
        return { value, output: value };
      },
      { identify: () => this.fingerprint(name, 'value', undefined, { produce: kind }) },
    );
  }

  /**
   * Runs one Claude session as a step. The session is always fresh; it never
   * inherits another step's conversation.
   *
   * Declaring `output` turns the session's answer into a schema-validated Output,
   * which is the only channel by which a session communicates a decision.
   */
  claude(options: ClaudeStepOptions<undefined>): Promise<ClaudeHandle<undefined>>;
  claude<S extends Schema>(
    options: ClaudeStepOptions<S> & { output: S },
  ): Promise<ClaudeHandle<Infer<S>>>;
  async claude(options: ClaudeStepOptions<Schema | undefined>): Promise<ClaudeHandle<unknown>> {
    // Settled before the step begins. Nothing about it depends on the run, and passing
    // it from `identify` to `work` through a mutable binding would make the order the
    // runner happens to call those two in load-bearing.
    const jsonSchema = options.output ? await toJsonSchema(options.name, options.output) : undefined;

    return this.runner.execute(this.runner.beginStep(options.name, 'claude'), async (step, signal) => {
      const cache = this.cacheSlot(step, options.cache);

      const settled = await this.settle(
        step,
        (prior) => ({ output: prior.output, text: prior.text ?? '', sessionId: prior.sessionId }),
        // A session acts on the workspace, which snapshots restore, so repeating one
        // costs tokens rather than correctness.
        { onCrash: this.onCrash(options.onCrash, 'rerun'), signal },
        cache,
      );

      if (settled) {
        const stored = settled.value as { output?: unknown; text: string; sessionId?: string };
        if (settled.from === 'cache') step.cacheHit = true;
        const handle: ClaudeHandle<unknown> = {
          name: options.name,
          output: stored.output,
          text: stored.text,
          sessionId: stored.sessionId,
          cacheHit: step.cacheHit === true,
          step,
        };
        return { value: handle, ...produced(handle) };
      }

      const handle = await this.runClaudeStep(options, jsonSchema, step, signal);
      // The same three fields the runner records are the three the cache keeps, and
      // `settle` reads them back into the branch above.
      await cache?.set(produced(handle));
      return { value: handle, ...produced(handle) };
    }, {
      timeout: options.timeout,
      // Derived from the options themselves rather than a hand-written list, so a
      // field added to ClaudeStepOptions cannot quietly fall out of the key.
      identify: () =>
        this.fingerprint(options.name, 'claude', options.cache, {
          ...stepConfig(options),
          jsonSchema,
          model: options.model ?? this.runner.config.model,
        }),
    });
  }

  /** @internal */
  private async runClaudeStep(
    options: ClaudeStepOptions<Schema | undefined>,
    jsonSchema: Record<string, unknown> | undefined,
    step: StepRecord,
    signal: AbortSignal,
  ): Promise<ClaudeHandle<unknown>> {
    const request: ClaudeRequest = {
      runId: this.runId,
      stepId: step.id,
      stepName: options.name,
      prompt: options.prompt,
      jsonSchema,
      model: options.model ?? this.runner.config.model,
      cwd: options.cwd ?? this.workspace,
      maxTurns: options.maxTurns,
      allowedTools: options.allowedTools,
      disallowedTools: options.disallowedTools,
      permissionMode: options.permissionMode ?? 'bypassPermissions',
      skills: options.skills ?? 'all',
      settingSources: options.settingSources ?? ['project'],
      mcpServers: options.mcpServers,
      signal,
    };

    const runClaude = this.runner.config.claude ?? (this.runner.claudeRunner ??= createClaudeRunner());
    const attempts = Math.max(0, options.retry ?? 0) + 1;
    let lastError: unknown;

    for (let attempt = 1; attempt <= attempts; attempt++) {
      this.runner.throwIfAborted();
      step.attempts = attempt;
      let pending: Promise<void> = Promise.resolve();
      try {
        const response = await runClaude(request, (message) => {
          pending = pending.then(() => this.runner.message(step, message));
        });
        await pending;

        let output: unknown;
        if (options.output) {
          if (response.structuredOutput === undefined) {
            throw new Error('session produced no structured_output');
          }
          output = options.output.parse(response.structuredOutput);
        }
        return {
          name: options.name,
          output,
          text: response.text,
          sessionId: response.sessionId,
          cacheHit: false,
          step,
        };
      } catch (error) {
        await pending.catch(() => {});
        if (isHalt(error)) throw error;
        lastError = error;
      }
    }

    throw new ClaudeStepError(options.name, attempts, lastError);
  }

  /**
   * Runs a shell command as a step. Throws on a non-zero exit unless the step
   * declared `allowFailure`, in which case the handle carries the exit code.
   */
  command(options: CommandStepOptions): Promise<CommandHandle> {
    const step = this.runner.beginStep(commandStepName(options), 'command');
    return this.commandStep(options, step);
  }

  /**
   * Runs several command steps at once, resolving to their handles in the order they
   * were declared. `concurrency` bounds how many run together; by default they all do.
   *
   * Command steps only. ADR 0004 rules out concurrent Claude steps because they share
   * one workspace and would race on the same files — that hazard is real and this does
   * not touch it. A fan-out of read-only checks (lint, test, typecheck) has no such
   * problem, and was the case that motivated the SDK in the first place.
   *
   * Every member is keyed against the same upstream Outputs, snapshotted before the
   * group starts. Without that a member's cache key would depend on which sibling
   * happened to finish first, and the same group would key differently run to run.
   */
  async commands(
    list: readonly CommandStepOptions[],
    options: { concurrency?: number } = {},
  ): Promise<CommandHandle[]> {
    const upstream = this.runner.upstreamOutputs();
    // Places are claimed for all of them first, so the run records the group in the
    // order it was written rather than the order it finished.
    const steps = list.map((item) => this.runner.beginStep(commandStepName(item), 'command'));
    const limiter = new Limiter(options.concurrency ?? Infinity);

    const settled = await Promise.allSettled(
      list.map((item, i) => limiter.run(() => this.commandStep(item, steps[i]!, upstream))),
    );

    // Siblings are allowed to finish before the group throws: a failed group should
    // still record every step it started, not leave half of them unfinished.
    const failure = settled.find((result) => result.status === 'rejected');
    if (failure) throw (failure as PromiseRejectedResult).reason;
    return settled.map((result) => (result as PromiseFulfilledResult<CommandHandle>).value);
  }

  /** @internal The body of one command step, however it was scheduled. */
  private commandStep(
    options: CommandStepOptions,
    step: StepRecord,
    upstream?: { name: string; output: unknown }[],
  ): Promise<CommandHandle> {
    const name = step.name;
    const cwd = options.cwd ?? this.workspace;
    return this.runner.execute(step, async (record, signal) => {
      const cache = this.cacheSlot(record, options.cache);

      const settled = await this.settle(record, (prior) => prior.output, {
        // A command acts on the workspace by default; one that reaches outside it
        // should say `onCrash: 'fail'`.
        onCrash: this.onCrash(options.onCrash, 'rerun'),
        signal,
      }, cache);
      if (settled) {
        const outcome = settled.value as CommandOutcome;
        if (settled.from === 'cache') record.cacheHit = true;
        // Annotated rather than returned: an exit code must be on the record even when
        // the step goes on to throw for having it.
        record.exitCode = outcome.exitCode;
        return { value: commandHandle(name, outcome, record, record.cacheHit === true), output: outcome };
      }

      const outcome = await runCommand(options, cwd, signal);
      record.exitCode = outcome.exitCode;
      assertCommandOk(options, outcome);
      await cache?.set(outcome);
      return { value: commandHandle(name, outcome, record, false), output: outcome };
    }, {
      timeout: options.timeout,
      identify: () => this.fingerprint(name, 'command', options.cache, stepConfig(options), upstream),
    });
  }

  /**
   * The identity of a step's work.
   *
   * Computed for every step, not only cacheable ones: a cacheable step uses it as its
   * cache key, and a resumed run uses it to decide whether an earlier run's result for
   * this step still stands. One value, because both questions are the same question.
   */
  private async fingerprint(
    stepName: string,
    kind: string,
    cache: CacheOptions | undefined,
    config: Record<string, unknown>,
    upstream: { name: string; output: unknown }[] = this.runner.upstreamOutputs(),
  ): Promise<string> {
    return computeCacheKey({
      pipeline: this.runner.config.pipeline,
      stepName,
      kind,
      config,
      inputs: cache?.inputs ?? [],
      workspace: this.workspace,
      pipelineInput: this.input,
      upstream,
      model: this.runner.config.model ?? 'default',
    });
  }

  /**
   * The cache as one step sees it: one key, used both to read and to write, or nothing
   * at all when the step did not opt in or the run was given no adapter. Steps are never
   * cacheable by default.
   *
   * Handing out a slot rather than a boolean is what keeps the key in one place. A
   * caller cannot consult one cache entry and write another, and cannot reach the
   * adapter without having been given the entry it is allowed to touch.
   */
  private cacheSlot(record: StepRecord, cache: CacheOptions | undefined): CacheSlot | undefined {
    const adapter = this.runner.config.cache;
    if (!cache || !adapter) return undefined;
    const key = record.fingerprint!;
    record.cacheKey = key;
    record.cacheHit = false;
    return {
      get: async () => adapter.get(key),
      set: async (value) => {
        await adapter.set(key, value);
      },
    };
  }

  /**
   * A step's crash policy: what the step declared, else what the pipeline declared for
   * all of its steps, else the default for the kind (ADR 0009).
   */
  private onCrash(declared: CrashPolicy | undefined, byKind: CrashPolicy): CrashPolicy {
    return declared ?? this.runner.config.defaults?.onCrash ?? byKind;
  }

  /**
   * Whether this step's work has already been done, and if so by what.
   *
   * Four answers, in the order they are asked for:
   *
   * 1. **The resumed run completed it.** Replay its result. Resuming and caching ask
   *    the same question and differ only in where the answer is kept, so they are one
   *    lookup rather than two branches at every call site — and the resumed run wins,
   *    because it is the more specific answer and it is free.
   * 2. **The resumed run was in the middle of it when its process died.** Nobody knows
   *    whether it landed; ADR 0009 decides, below.
   * 3. **The cache holds it.** Only for a step that was given a slot.
   * 4. **Nothing has.** Do the work — and first, put the workspace back to where the
   *    replayed steps left it, because that is the tree this work expects.
   *
   * Which of the three it was comes back on `from`. A caller needs to know — a cache hit
   * is recorded as one, a replayed step and a reconciled effect are not — and this is
   * the only place that can say without guessing.
   */
  private async settle(
    record: StepRecord,
    fromReplay: (prior: StepRecord) => unknown,
    crash: {
      onCrash: CrashPolicy;
      reconcile?: (signal: AbortSignal) => unknown;
      signal: AbortSignal;
    },
    cache?: CacheSlot,
  ): Promise<Settled | undefined> {
    const fingerprint = record.fingerprint!;

    const prior = this.runner.replay(fingerprint);
    if (prior) {
      this.runner.noteReplayed(record, prior);
      return { value: fromReplay(prior), from: 'replay' };
    }

    const inFlight = this.runner.inFlight(fingerprint);
    if (inFlight) {
      // Whatever happens next touches the workspace, so it must see the tree the
      // crashed run was working against, not the one this process started with.
      await this.runner.restoreWorkspace(crash.signal, record);
      if (crash.reconcile) {
        const found = await crash.reconcile(crash.signal);
        if (found !== undefined) {
          record.recovered = 'reconciled';
          return { value: found, from: 'reconcile' };
        }
        // Asked and answered: the effect did not land, so repeating it is safe. This is
        // what having a reconcile buys — `onCrash` decides only what to do when there
        // is nothing to ask.
        record.recovered = 'rerun';
      } else if (crash.onCrash === 'fail') {
        throw new IndeterminateStepError(record.name, inFlight.id);
      } else {
        record.recovered = 'rerun';
      }
    }

    if (cache) {
      const hit = await cache.get();
      if (hit !== undefined) return { value: hit, from: 'cache' };
    }

    await this.runner.restoreWorkspace(crash.signal, record);
    return undefined;
  }

  /**
   * Ends the run early and successfully. Declared steps not yet reached are
   * recorded as skipped. Returns `never`, so code below it is unreachable.
   */
  halt(reason: string): never {
    throw new HaltSignal(reason);
  }
}

/** What a Claude step produced, as the runner records it — cached or freshly run alike. */
function produced(handle: ClaudeHandle<unknown>): { output: unknown; text: string; sessionId?: string } {
  return { output: handle.output, text: handle.text, sessionId: handle.sessionId };
}

/** A command step's recorded name: what it declared, else the command itself. */
function commandStepName(options: CommandStepOptions): string {
  return options.name ?? options.command;
}

/**
 * Everything a step declared except its identity and its own cache declaration.
 * Spreading the options means a new option is part of the key by default; leaving one
 * out has to be a deliberate act, which is the safe direction for ADR 0006.
 */
function stepConfig(options: object): Record<string, unknown> {
  // `timeout` joins name and cache in the deliberate exclusion list: how long a step is
  // allowed to take does not change the result it produces, so two runs that differ only
  // in a deadline should still share a cache entry.
  // `onCrash` joins them: what a step does about a crash it did not have does not
  // change the result it produces.
  // `output` is excluded because it is already in the key in the form that matters: the
  // caller adds the JSON Schema it compiles to, and hashing the Zod object as well would
  // key on the identity of a class instance.
  const {
    name: _name,
    cache: _cache,
    timeout: _timeout,
    onCrash: _onCrash,
    output: _output,
    ...rest
  } = options as Record<string, unknown>;
  return rest;
}

/**
 * Zod is a peer dependency, imported only when a step declares an Output schema,
 * so pipelines without one do not need it loaded.
 */
async function toJsonSchema(stepName: string, schema: object): Promise<Record<string, unknown>> {
  const { toJSONSchema } = await import('zod');
  try {
    const json = toJSONSchema(schema as never, { io: 'output' }) as Record<string, unknown>;
    // The CLI validates the schema with a resolver that does not know the 2020-12
    // meta-schema by URL, and rejects it outright. The dialect is implicit anyway.
    delete json.$schema;
    return json;
  } catch (error) {
    throw new Error(
      `Output schema for step "${stepName}" cannot be expressed as JSON Schema: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}
