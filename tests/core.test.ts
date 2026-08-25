import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { definePipeline, PipelineInputError } from '../src/index.ts';
import type { RunRecord, StepRecord } from '../src/index.ts';

describe('core runner', () => {
  test('runs steps sequentially and returns the pipeline output', async () => {
    const order: string[] = [];
    const pipeline = definePipeline({
      name: 'sequential',
      input: z.object({ n: z.number() }),
      async run(ctx) {
        const a = await ctx.step('a', async () => {
          await Bun.sleep(5);
          order.push('a');
          return ctx.input.n + 1;
        });
        const b = await ctx.step('b', () => {
          order.push('b');
          return a * 2;
        });
        return { b };
      },
    });

    const result = await pipeline.run({ input: { n: 1 } });

    expect(order).toEqual(['a', 'b']);
    expect(result.status).toBe('completed');
    expect(result.output).toEqual({ b: 4 });
    expect(result.steps.map((s) => s.name)).toEqual(['a', 'b']);
    expect(result.steps.map((s) => s.index)).toEqual([0, 1]);
    expect(result.steps.every((s) => s.status === 'completed')).toBe(true);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  test('validates the input against the declared schema', async () => {
    const pipeline = definePipeline({
      name: 'typed-input',
      input: z.object({ issueId: z.number() }),
      run: (ctx) => ctx.input.issueId,
    });

    expect(pipeline.run({ input: { issueId: 'nope' } as never })).rejects.toThrow(
      PipelineInputError,
    );
  });

  test('halt ends the run successfully and marks later declared steps skipped', async () => {
    const reached: string[] = [];
    const pipeline = definePipeline({
      name: 'halting',
      steps: ['first', 'second', 'third'],
      async run(ctx) {
        await ctx.step('first', () => reached.push('first'));
        ctx.halt('nothing to do');
        await ctx.step('second', () => reached.push('second'));
        await ctx.step('third', () => reached.push('third'));
        return 'unreachable';
      },
    });

    const result = await pipeline.run({ input: undefined });

    expect(result.status).toBe('halted');
    expect(result.haltReason).toBe('nothing to do');
    expect(result.error).toBeUndefined();
    expect(reached).toEqual(['first']);

    const byName = Object.fromEntries(result.steps.map((s) => [s.name, s.status]));
    expect(byName).toEqual({ first: 'completed', second: 'skipped', third: 'skipped' });
  });

  test('halt from inside a step is a halt, not a step failure', async () => {
    const pipeline = definePipeline({
      name: 'halt-inside-step',
      steps: ['decide', 'after'],
      async run(ctx) {
        await ctx.step('decide', () => ctx.halt('decided against it'));
        await ctx.step('after', () => 'never');
      },
    });

    const result = await pipeline.run({ input: undefined });

    expect(result.status).toBe('halted');
    expect(result.steps.find((s) => s.name === 'decide')?.status).toBe('completed');
    expect(result.steps.find((s) => s.name === 'after')?.status).toBe('skipped');
  });

  test('a throwing step fails the run and records the error', async () => {
    const pipeline = definePipeline({
      name: 'failing',
      steps: ['boom', 'never'],
      async run(ctx) {
        await ctx.step('boom', () => {
          throw new Error('kaboom');
        });
        await ctx.step('never', () => 'nope');
      },
    });

    const result = await pipeline.run({ input: undefined });

    expect(result.status).toBe('failed');
    expect(result.error).toContain('kaboom');
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]!.status).toBe('failed');
    expect(result.steps[0]!.error).toContain('kaboom');
  });

  test('a failed run does not record skipped steps', async () => {
    const pipeline = definePipeline({
      name: 'failing-declared',
      steps: ['boom', 'later'],
      async run(ctx) {
        await ctx.step('boom', () => {
          throw new Error('kaboom');
        });
      },
    });

    const result = await pipeline.run({ input: undefined });
    expect(result.steps.map((s) => s.name)).toEqual(['boom']);
  });

  test('emits run and step lifecycle events in order', async () => {
    const events: string[] = [];
    const pipeline = definePipeline({
      name: 'events',
      async run(ctx) {
        await ctx.step('only', () => 1);
      },
    });

    await pipeline.run({
      input: undefined,
      on: {
        runStarted: (r: RunRecord) => events.push(`run:${r.status}`),
        stepStarted: (s: StepRecord) => events.push(`step+:${s.name}`),
        stepFinished: (s: StepRecord) => events.push(`step-:${s.name}:${s.status}`),
        runFinished: (r: RunRecord) => events.push(`done:${r.status}`),
      },
    });

    expect(events).toEqual([
      'run:running',
      'step+:only',
      'step-:only:completed',
      'done:completed',
    ]);
  });

  test('an event listener that throws does not fail the run', async () => {
    const seen: unknown[] = [];
    const pipeline = definePipeline({
      name: 'noisy-listener',
      async run(ctx) {
        await ctx.step('only', () => 1);
      },
    });

    const result = await pipeline.run({
      input: undefined,
      on: {
        stepStarted: () => {
          throw new Error('listener blew up');
        },
        error: (e) => seen.push(e),
      },
    });

    expect(result.status).toBe('completed');
    expect(seen).toHaveLength(1);
  });

  test('the workspace defaults to the current directory and is exposed on ctx', async () => {
    const pipeline = definePipeline({
      name: 'workspace',
      run: (ctx) => ctx.workspace,
    });

    expect((await pipeline.run({ input: undefined })).output).toBe(process.cwd());
    expect((await pipeline.run({ input: undefined, workspace: '/tmp' })).output).toBe('/tmp');
  });
});
