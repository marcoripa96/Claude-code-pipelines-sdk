import type { Runner } from './runner.ts';
import type {
  ClaudeHandle,
  ClaudeRequest,
  ClaudeStepOptions,
  CommandHandle,
  CommandStepOptions,
  Infer,
  Schema,
} from './types.ts';
import { assertCommandOk, commandHandle, runCommand } from './command.ts';
import { ClaudeStepError, HaltSignal, isHalt } from './errors.ts';
import { createClaudeRunner } from './claude.ts';

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

  /** Runs arbitrary code as a step. This is where External effects belong. */
  step<T>(name: string, fn: () => T | Promise<T>): Promise<T> {
    return this.runner.execute(name, 'code', async () => {
      const value = await fn();
      return { value, output: value };
    });
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
    return this.runner.execute(options.name, 'claude', async (step) => {
      const handle = await this.runClaudeStep(options, step);
      return { value: handle, output: handle.output, text: handle.text };
    });
  }

  /** @internal */
  private async runClaudeStep(
    options: ClaudeStepOptions<Schema | undefined>,
    step: import('./types.ts').StepRecord,
  ): Promise<ClaudeHandle<unknown>> {
    const request: ClaudeRequest = {
      stepName: options.name,
      prompt: options.prompt,
      jsonSchema: options.output ? await toJsonSchema(options.name, options.output) : undefined,
      model: options.model ?? this.runner.config.model,
      cwd: options.cwd ?? this.workspace,
      maxTurns: options.maxTurns,
      allowedTools: options.allowedTools,
      disallowedTools: options.disallowedTools,
      permissionMode: options.permissionMode ?? 'bypassPermissions',
      skills: options.skills ?? 'all',
      settingSources: options.settingSources ?? ['project'],
      mcpServers: options.mcpServers,
      signal: this.runner.config.signal,
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
    const name = options.name ?? options.command;
    const cwd = options.cwd ?? this.workspace;
    return this.runner.execute(name, 'command', async (step) => {
      const outcome = await runCommand(options, cwd);
      step.exitCode = outcome.exitCode;
      assertCommandOk(options, outcome);
      const handle = commandHandle(name, outcome, step, false);
      return { value: handle, output: outcome };
    });
  }

  /**
   * Ends the run early and successfully. Declared steps not yet reached are
   * recorded as skipped. Returns `never`, so code below it is unreachable.
   */
  halt(reason: string): never {
    throw new HaltSignal(reason);
  }
}

/**
 * Zod is a peer dependency, imported only when a step declares an Output schema,
 * so pipelines without one do not need it loaded.
 */
async function toJsonSchema(stepName: string, schema: object): Promise<Record<string, unknown>> {
  const { toJSONSchema } = await import('zod');
  try {
    return toJSONSchema(schema as never, { io: 'output' }) as Record<string, unknown>;
  } catch (error) {
    throw new Error(
      `Output schema for step "${stepName}" cannot be expressed as JSON Schema: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}
