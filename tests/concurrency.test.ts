import { describe, expect, test } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { definePipeline, memoryCache } from '../src/index.ts';
import { Limiter } from '../src/limiter.ts';

const workspace = () => mkdtemp(join(tmpdir(), 'concurrency-test-'));

describe('ctx.commands', () => {
  test('runs the group at once and returns handles in declaration order', async () => {
    const pipeline = definePipeline({
      name: 'fan-out',
      async run(ctx) {
        const [lint, test_, types] = await ctx.commands([
          { name: 'lint', command: 'sleep 0.2 && echo lint' },
          { name: 'test', command: 'sleep 0.2 && echo test' },
          { name: 'typecheck', command: 'sleep 0.2 && echo typecheck' },
        ]);
        return [lint!.stdout.trim(), test_!.stdout.trim(), types!.stdout.trim()];
      },
    });

    const started = Date.now();
    const result = await pipeline.run({ input: undefined });
    const elapsed = Date.now() - started;

    expect(result.status).toBe('completed');
    expect(result.output).toEqual(['lint', 'test', 'typecheck']);
    // Sequentially this would be ~600ms; concurrently it is ~200ms.
    expect(elapsed).toBeLessThan(500);
  });

  test('records the group in declaration order even when it finishes out of order', async () => {
    const pipeline = definePipeline({
      name: 'ordering',
      async run(ctx) {
        await ctx.commands([
          { name: 'slow', command: 'sleep 0.3 && echo slow' },
          { name: 'quick', command: 'echo quick' },
        ]);
      },
    });

    const result = await pipeline.run({ input: undefined });
    expect(result.steps.map((s) => s.name)).toEqual(['slow', 'quick']);
    expect(result.steps.map((s) => s.index)).toEqual([0, 1]);
  });

  test('concurrency bounds how many run together', async () => {
    let active = 0;
    let peak = 0;
    const pipeline = definePipeline({
      name: 'bounded',
      async run(ctx) {
        await ctx.commands(
          [1, 2, 3, 4, 5].map((n) => ({ name: `job-${n}`, command: 'sleep 0.15' })),
          { concurrency: 2 },
        );
      },
    });

    // Measured from the run's own events rather than from the filesystem: a step is
    // in flight exactly between its stepStarted and its stepFinished.
    const result = await pipeline.run({
      input: undefined,
      on: {
        stepStarted: () => {
          active += 1;
          peak = Math.max(peak, active);
        },
        stepFinished: () => {
          active -= 1;
        },
      },
    });

    expect(result.status).toBe('completed');
    expect(result.steps).toHaveLength(5);
    expect(peak).toBe(2);
  });

  test('a failing member fails the run, and every sibling is still recorded', async () => {
    const pipeline = definePipeline({
      name: 'one-bad',
      async run(ctx) {
        await ctx.commands([
          { name: 'ok-1', command: 'sleep 0.1 && echo fine' },
          { name: 'bad', command: 'exit 4' },
          { name: 'ok-2', command: 'sleep 0.1 && echo fine' },
        ]);
      },
    });

    const result = await pipeline.run({ input: undefined });
    expect(result.status).toBe('failed');
    expect(result.steps).toHaveLength(3);
    // No sibling is left unfinished just because another member failed first.
    expect(result.steps.map((s) => s.status)).toEqual(['completed', 'failed', 'completed']);
    expect(result.steps.every((s) => s.finishedAt !== undefined)).toBe(true);
    expect(result.steps[1]!.exitCode).toBe(4);
  });

  test('a member sees the same upstream snapshot however its siblings are scheduled', async () => {
    const cwd = await workspace();
    const cache = memoryCache();
    const build = () =>
      definePipeline({
        name: 'stable-keys',
        async run(ctx) {
          await ctx.step('seed', () => 'upstream-value');
          return await ctx.commands([
            { name: 'a', command: 'sleep 0.2 && echo a', cache: {} },
            { name: 'b', command: 'echo b', cache: {} },
            { name: 'c', command: 'sleep 0.1 && echo c', cache: {} },
          ]);
        },
      });

    const first = await build().run({ input: undefined, workspace: cwd, cache });
    const second = await build().run({ input: undefined, workspace: cwd, cache });

    // Keyed off a snapshot taken before the group, so completion order cannot change
    // them: every member is a hit the second time round.
    for (const step of second.steps.filter((s) => s.kind === 'command')) {
      expect(step.cacheHit).toBe(true);
    }
    const keysOf = (r: typeof first) =>
      r.steps.filter((s) => s.kind === 'command').map((s) => s.cacheKey);
    expect(keysOf(second)).toEqual(keysOf(first));
  });

  test('a member honours its own timeout without taking the group down early', async () => {
    const pipeline = definePipeline({
      name: 'group-timeout',
      async run(ctx) {
        await ctx.commands([
          { name: 'hangs', command: 'sleep 5', timeout: 100 },
          { name: 'fine', command: 'echo ok' },
        ]);
      },
    });

    const started = Date.now();
    const result = await pipeline.run({ input: undefined });
    expect(result.status).toBe('failed');
    expect(Date.now() - started).toBeLessThan(2000);
    expect(result.steps[0]!.status).toBe('failed');
    expect(result.steps[1]!.status).toBe('completed');
  });
});

describe('Limiter', () => {
  test('a caller arriving as a slot frees cannot overtake the waiter', async () => {
    const limiter = new Limiter(1);
    let active = 0;
    let peak = 0;
    const body = async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active -= 1;
    };

    let open!: () => void;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });

    const holder = limiter.run(() => gate);
    const waiter = limiter.run(body);
    // Calls run() in the very microtask turn the slot is released.
    const barger = gate.then(() => limiter.run(body));

    open();
    await Promise.all([holder, waiter, barger]);
    expect(peak).toBe(1);
  });

  test('a rejecting task releases its slot', async () => {
    const limiter = new Limiter(1);
    await expect(limiter.run(() => Promise.reject(new Error('nope')))).rejects.toThrow('nope');
    expect(await limiter.run(async () => 'after')).toBe('after');
  });
});
