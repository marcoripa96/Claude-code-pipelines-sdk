import { describe, expect, test } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { definePipeline, memoryCache, StepTimeoutError } from '../src/index.ts';
import type { ClaudeRequest, ClaudeResponse } from '../src/claude.ts';

const workspace = () => mkdtemp(join(tmpdir(), 'timeout-test-'));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function timedOut(cause: unknown): StepTimeoutError {
  // A step's failure is wrapped by the runner; the deadline is the cause underneath.
  const inner = cause instanceof Error && cause.cause !== undefined ? cause.cause : cause;
  expect(inner).toBeInstanceOf(StepTimeoutError);
  return inner as StepTimeoutError;
}

describe('step timeouts', () => {
  test('a code step that ignores its signal still fails on time', async () => {
    const pipeline = definePipeline({
      name: 'slow-code',
      steps: ['sleeper', 'after'],
      async run(ctx) {
        await ctx.step('sleeper', () => sleep(5000).then(() => 'finished anyway'), { timeout: 50 });
        await ctx.step('after', () => 'never');
      },
    });

    const started = Date.now();
    const result = await pipeline.run({ input: undefined });

    expect(result.status).toBe('failed');
    expect(Date.now() - started).toBeLessThan(2000);
    expect(timedOut(result.cause).timeoutMs).toBe(50);
    expect(result.steps[0]!.status).toBe('failed');
    expect(result.steps[0]!.error).toContain('timed out after 50ms');
  });

  test('a code step can cancel its own work through the signal it is handed', async () => {
    let observed: string | undefined;
    const pipeline = definePipeline({
      name: 'cooperative',
      async run(ctx) {
        await ctx.step(
          'watches',
          (signal) =>
            new Promise((_, reject) => {
              signal.addEventListener('abort', () => {
                observed = 'aborted';
                reject(new Error('cancelled by signal'));
              });
            }),
          { timeout: 50 },
        );
      },
    });

    const result = await pipeline.run({ input: undefined });
    expect(result.status).toBe('failed');
    expect(observed).toBe('aborted');
  });

  test('a command step is killed, not merely abandoned', async () => {
    const cwd = await workspace();
    const pipeline = definePipeline({
      name: 'slow-command',
      async run(ctx) {
        await ctx.command({
          name: 'sleeper',
          command: 'sleep 5 && echo survived > survivor.txt',
          timeout: 50,
        });
      },
    });

    const started = Date.now();
    const result = await pipeline.run({ input: undefined, workspace: cwd });
    expect(result.status).toBe('failed');
    expect(Date.now() - started).toBeLessThan(2000);
    expect(timedOut(result.cause).timeoutMs).toBe(50);

    // Had the process merely been abandoned it would still be running and would write
    // this file once its sleep elapsed.
    await sleep(300);
    expect(await Bun.file(join(cwd, 'survivor.txt')).exists()).toBe(false);
  });

  test('a claude step honours its timeout', async () => {
    const slowClaude = async (_request: ClaudeRequest): Promise<ClaudeResponse> => {
      await sleep(5000);
      return { finalMessage: 'too late' };
    };

    const pipeline = definePipeline({
      name: 'slow-claude',
      async run(ctx) {
        await ctx.claude({ name: 'thinker', prompt: 'hello', timeout: 50 });
      },
    });

    const started = Date.now();
    const result = await pipeline.run({ input: undefined, claude: slowClaude });
    expect(result.status).toBe('failed');
    expect(Date.now() - started).toBeLessThan(2000);
    expect(timedOut(result.cause).timeoutMs).toBe(50);
  });

  test('a step that finishes inside its timeout is unaffected', async () => {
    const pipeline = definePipeline({
      name: 'quick',
      async run(ctx) {
        const code = await ctx.step('fast', () => 'done', { timeout: 5000 });
        const shell = await ctx.command({ name: 'echo', command: 'echo hi', timeout: 5000 });
        return `${code}:${shell.stdout.trim()}`;
      },
    });

    const result = await pipeline.run({ input: undefined });
    expect(result.status).toBe('completed');
    expect(result.output).toBe('done:hi');
  });

  test('a deadline is not part of the cache key', async () => {
    const cwd = await workspace();
    const cache = memoryCache();
    const build = (timeout: number) =>
      definePipeline({
        name: 'cached',
        async run(ctx) {
          return await ctx.command({
            name: 'tick',
            command: 'echo tick >> counter.txt && wc -l < counter.txt',
            cache: {},
            timeout,
          });
        },
      });

    const first = await build(1000).run({ input: undefined, workspace: cwd, cache });
    const second = await build(9000).run({ input: undefined, workspace: cwd, cache });

    expect(first.steps[0]!.cacheHit).toBe(false);
    // How long a step was allowed to take does not change what it produced.
    expect(second.steps[0]!.cacheHit).toBe(true);
    expect(second.steps[0]!.cacheKey).toBe(first.steps[0]!.cacheKey!);
  });

  test('a run without any timeout is unchanged', async () => {
    const pipeline = definePipeline({
      name: 'no-deadline',
      async run(ctx) {
        return await ctx.step('work', () => 'value');
      },
    });

    const result = await pipeline.run({ input: undefined });
    expect(result.status).toBe('completed');
    expect(result.output).toBe('value');
  });
});
