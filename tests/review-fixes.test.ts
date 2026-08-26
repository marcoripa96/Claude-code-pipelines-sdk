import { describe, expect, test } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { definePipeline, fake, memoryCache, WorkspaceUnrestorableError } from '../src/index.ts';
import type { RunResult, StepRecord, WorkspaceSnapshots } from '../src/index.ts';
import { Limiter } from '../src/limiter.ts';

const workspace = () => mkdtemp(join(tmpdir(), 'review-test-'));

describe('a replayed snapshot this run cannot restore', () => {
  const snapshots: WorkspaceSnapshots = {
    capture: () => 'snapshot-id',
    restore: () => {},
  };

  const pipeline = definePipeline({
    name: 'snapshot-required',
    async run(ctx) {
      await ctx.claude({ name: 'edit', prompt: 'edit the tree' });
      return 'done';
    },
  });

  test('stops the run rather than continuing against a tree it never put back', async () => {
    const cwd = await workspace();
    const claude = fake({ edit: 'edited' });

    const first = await pipeline.run({ input: undefined, workspace: cwd, claude, snapshots });
    expect(first.status).toBe('completed');
    expect(first.steps[0]!.snapshot).toBe('snapshot-id');

    // Resumed without the adapter: the Output could replay, the files could not.
    const second = await pipeline.run({
      input: undefined,
      workspace: cwd,
      claude,
      resumeFrom: first,
    });

    expect(second.status).toBe('failed');
    expect(second.error).toContain('no `snapshots` adapter');
    expect((second.cause as { cause?: unknown }).cause).toBeInstanceOf(WorkspaceUnrestorableError);
    // And it stopped at the step, rather than reporting a run that quietly did nothing.
    expect(second.steps[0]!.status).toBe('failed');
    expect(second.steps[0]!.snapshot).toBeUndefined();
  });

  test('resumes normally when the adapter is supplied again', async () => {
    const cwd = await workspace();
    const claude = fake({ edit: 'edited' });
    const first = await pipeline.run({ input: undefined, workspace: cwd, claude, snapshots });

    const second = await pipeline.run({
      input: undefined,
      workspace: cwd,
      claude,
      snapshots,
      resumeFrom: first,
    });

    expect(second.status).toBe('completed');
    expect(second.steps[0]!.replayed).toBe(true);
  });
});

describe('concurrency bounds', () => {
  test('zero and negatives are refused rather than read as unbounded', () => {
    expect(() => new Limiter(0)).toThrow(RangeError);
    expect(() => new Limiter(-1)).toThrow(RangeError);
    expect(() => new Limiter(Number.NaN)).toThrow(RangeError);
  });

  test('Infinity is still how unbounded is spelled', async () => {
    const limiter = new Limiter(Infinity);
    expect(await limiter.run(async () => 'ran')).toBe('ran');
  });

  test('ctx.commands rejects a group it was told to run zero at a time', async () => {
    const pipeline = definePipeline({
      name: 'bad-concurrency',
      async run(ctx) {
        return ctx.commands([{ command: 'echo one' }], { concurrency: 0 });
      },
    });

    const result = await pipeline.run({ input: undefined, workspace: await workspace() });
    expect(result.status).toBe('failed');
    expect(result.error).toContain('concurrency must be at least 1');
  });
});

describe('cacheHit says where the answer came from', () => {
  const pipeline = definePipeline({
    name: 'cache-provenance',
    async run(ctx) {
      return (await ctx.command({ name: 'echo', command: 'echo hi', cache: { inputs: [] } })).stdout;
    },
  });

  test('a replayed step is not recorded as a cache hit', async () => {
    const cwd = await workspace();
    const cache = memoryCache();

    const first = await pipeline.run({ input: undefined, workspace: cwd, cache });
    const second = await pipeline.run({ input: undefined, workspace: cwd, cache, resumeFrom: first });

    // Both a replay and a cache hit avoid the work; only one of them is a cache hit, and
    // the record has to be able to tell them apart.
    expect(second.steps[0]!.replayed).toBe(true);
    expect(second.steps[0]!.cacheHit).toBe(false);
  });

  test('a step answered by the cache is recorded as a cache hit', async () => {
    const cwd = await workspace();
    const cache = memoryCache();

    await pipeline.run({ input: undefined, workspace: cwd, cache });
    // A fresh run, so nothing replays: the cache is the only thing that can answer.
    const second = await pipeline.run({ input: undefined, workspace: cwd, cache });

    expect(second.steps[0]!.cacheHit).toBe(true);
    expect(second.steps[0]!.replayed).toBeUndefined();
    expect(second.steps[0]!.cacheKey).toBe(second.steps[0]!.fingerprint!);
  });

  test('a step with no cache adapter records neither', async () => {
    const result = await pipeline.run({ input: undefined, workspace: await workspace() });
    expect(result.steps[0]!.cacheHit).toBeUndefined();
    expect(result.steps[0]!.cacheKey).toBeUndefined();
  });
});

describe('pipeline-level step defaults', () => {
  const inFlightRun = (result: RunResult): RunResult => ({
    ...result,
    status: 'running',
    steps: result.steps.map((step): StepRecord => ({ ...step, status: 'running' })),
  });

  test('a code step follows the pipeline default instead of stopping to ask', async () => {
    const cwd = await workspace();
    let effects = 0;
    const pipeline = definePipeline({
      name: 'repeatable-effects',
      defaults: { onCrash: 'rerun' },
      async run(ctx) {
        return ctx.step('publish', () => {
          effects += 1;
          return 'published';
        });
      },
    });

    const crashed = await pipeline.run({ input: undefined, workspace: cwd });
    const recovered = await pipeline.run({
      input: undefined,
      workspace: cwd,
      resumeFrom: inFlightRun(crashed),
    });

    expect(recovered.status).toBe('completed');
    expect(recovered.steps[0]!.recovered).toBe('rerun');
    expect(effects).toBe(2);
  });

  test('without the default the same step still stops and asks', async () => {
    const cwd = await workspace();
    const pipeline = definePipeline({
      name: 'unknown-effects',
      async run(ctx) {
        return ctx.step('publish', () => 'published');
      },
    });

    const crashed = await pipeline.run({ input: undefined, workspace: cwd });
    const recovered = await pipeline.run({
      input: undefined,
      workspace: cwd,
      resumeFrom: inFlightRun(crashed),
    });

    expect(recovered.status).toBe('failed');
    expect(recovered.error).toContain('left in flight');
  });

  test('a step that declares its own policy overrides the pipeline default', async () => {
    const cwd = await workspace();
    const pipeline = definePipeline({
      name: 'one-step-disagrees',
      defaults: { onCrash: 'rerun' },
      async run(ctx) {
        return ctx.step('charge-the-card', () => 'charged', { onCrash: 'fail' });
      },
    });

    const crashed = await pipeline.run({ input: undefined, workspace: cwd });
    const recovered = await pipeline.run({
      input: undefined,
      workspace: cwd,
      resumeFrom: inFlightRun(crashed),
    });

    expect(recovered.status).toBe('failed');
    expect(recovered.error).toContain('left in flight');
  });
});
