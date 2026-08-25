import type { Runner } from './runner.ts';
import type {
  ClaudeHandle,
  ClaudeRequest,
  ClaudeStepOptions,
  CacheOptions,
  CommandHandle,
  CommandStepOptions,
  Infer,
  Schema,
  StepRecord,
} from './types.ts';
import type { CommandOutcome } from './command.ts';
import { assertCommandOk, commandHandle, runCommand } from './command.ts';
import { ClaudeStepError, HaltSignal, isHalt } from './errors.ts';
import { createClaudeRunner } from './claude.ts';
import { computeCacheKey } from './cache.ts';
import { Limiter } from './limiter.ts';

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
    options: { timeout?: number } = {},
  ): Promise<T> {
    return this.runner.execute(
      this.runner.beginStep(name, 'code'),
      async (record, signal) => {
        // A code step is where External effects live, so replaying one is the point:
        // a resumed run must not post the comment or open the pull request twice.
        // Its source is part of the identity — edit the function and it runs again.
        const fingerprint = await this.fingerprint(name, 'code', undefined, {
          source: fn.toString(),
        });
        record.fingerprint = fingerprint;

        const recalled = await this.recall(record, fingerprint, false, (prior) => prior.output);
        if (recalled) return { value: recalled.value as T, output: recalled.value };

        const value = await fn(signal);
        return { value, output: value };
      },
      { timeout: options.timeout },
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
  claude(options: ClaudeStepOptions<Schema | undefined>): Promise<ClaudeHandle<unknown>> {
    return this.runner.execute(this.runner.beginStep(options.name, 'claude'), async (step, signal) => {
      const jsonSchema = options.output
        ? await toJsonSchema(options.name, options.output)
        : undefined;

      // Derived from the options themselves rather than a hand-written list, so a
      // field added to ClaudeStepOptions cannot quietly fall out of the key.
      const cacheable = this.cacheable(options.cache);
      const fingerprint = await this.fingerprint(options.name, 'claude', options.cache, {
        ...stepConfig(options),
        output: undefined,
        jsonSchema,
        model: options.model ?? this.runner.config.model,
      });
      step.fingerprint = fingerprint;
      if (cacheable) {
        step.cacheKey = fingerprint;
        step.cacheHit = false;
      }

      const recalled = await this.recall(step, fingerprint, cacheable, (prior) => ({
        output: prior.output,
        text: prior.text ?? '',
        sessionId: prior.sessionId,
      }));

      if (recalled) {
        const stored = recalled.value as { output?: unknown; text: string; sessionId?: string };
        if (!step.replayed) step.cacheHit = true;
        step.sessionId = stored.sessionId;
        const handle: ClaudeHandle<unknown> = {
          name: options.name,
          output: stored.output,
          text: stored.text,
          sessionId: stored.sessionId,
          cacheHit: step.cacheHit === true,
          step,
        };
        return { value: handle, output: handle.output, text: handle.text };
      }

      const handle = await this.runClaudeStep(options, jsonSchema, step, signal);
      if (cacheable) {
        await this.runner.config.cache!.set(fingerprint, {
          output: handle.output,
          text: handle.text,
          sessionId: handle.sessionId,
        });
      }
      return { value: handle, output: handle.output, text: handle.text };
    }, { timeout: options.timeout });
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
        step.sessionId = response.sessionId;
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
      const cacheable = this.cacheable(options.cache);
      const fingerprint = await this.fingerprint(name, 'command', options.cache, stepConfig(options), upstream);
      record.fingerprint = fingerprint;
      if (cacheable) {
        record.cacheKey = fingerprint;
        record.cacheHit = false;
      }

      const recalled = await this.recall(record, fingerprint, cacheable, (prior) => prior.output);
      if (recalled) {
        const outcome = recalled.value as CommandOutcome;
        if (!record.replayed) record.cacheHit = true;
        record.exitCode = outcome.exitCode;
        return { value: commandHandle(name, outcome, record, record.cacheHit === true), output: outcome };
      }

      const outcome = await runCommand(options, cwd, signal);
      record.exitCode = outcome.exitCode;
      assertCommandOk(options, outcome);
      if (cacheable) await this.runner.config.cache!.set(fingerprint, outcome);
      const handle = commandHandle(name, outcome, record, false);
      return { value: handle, output: outcome };
    }, { timeout: options.timeout });
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
   * Whether a cacheable step may consult the cache: it opted in and the run was given
   * an adapter. Steps are never cacheable by default.
   */
  private cacheable(cache: CacheOptions | undefined): boolean {
    return Boolean(cache && this.runner.config.cache);
  }

  /**
   * A result for this fingerprint that already exists — from the run being resumed, or
   * from the cache when the step opted in.
   *
   * Resuming and caching ask the same question and differ only in where the answer
   * comes from, so they are one lookup rather than two branches at every call site.
   * The resumed run wins: it is the more specific answer, and it is free.
   */
  private async recall(
    record: StepRecord,
    fingerprint: string,
    cacheable: boolean,
    fromReplay: (prior: StepRecord) => unknown,
  ): Promise<{ value: unknown } | undefined> {
    const prior = this.runner.replay(fingerprint);
    if (prior) {
      record.replayed = true;
      return { value: fromReplay(prior) };
    }
    if (!cacheable) return undefined;
    const hit = await this.runner.config.cache!.get(fingerprint);
    return hit === undefined ? undefined : { value: hit };
  }

  /**
   * Ends the run early and successfully. Declared steps not yet reached are
   * recorded as skipped. Returns `never`, so code below it is unreachable.
   */
  halt(reason: string): never {
    throw new HaltSignal(reason);
  }
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
  const { name: _name, cache: _cache, timeout: _timeout, ...rest } = options as Record<string, unknown>;
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
