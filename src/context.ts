import type { Runner } from './runner.ts';
import type { CommandHandle, CommandStepOptions } from './types.ts';
import { assertCommandOk, commandHandle, runCommand } from './command.ts';
import { HaltSignal } from './errors.ts';

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
