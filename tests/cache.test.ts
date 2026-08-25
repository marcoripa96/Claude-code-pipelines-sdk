import { beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { computeCacheKey, definePipeline, memoryCache, sqliteCache } from '../src/index.ts';
import type { CacheKeyParts, ClaudeRunner } from '../src/index.ts';

let workspace: string;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'pipelines-cache-'));
  writeFileSync(join(workspace, 'package.json'), '{"name":"a"}');
});

function baseParts(): CacheKeyParts {
  return {
    pipeline: 'p',
    stepName: 'analyze',
    kind: 'claude',
    config: { prompt: 'Analyse.' },
    inputs: ['package.json'],
    workspace,
    pipelineInput: { issueId: 1 },
    upstream: [{ name: 'classify', output: { type: 'bug' } }],
    model: 'model-a',
  };
}

describe('cache keys', () => {
  test('are stable when nothing changes', async () => {
    expect(await computeCacheKey(baseParts())).toBe(await computeCacheKey(baseParts()));
  });

  test('do not depend on key order within the config', async () => {
    const a = await computeCacheKey({ ...baseParts(), config: { x: 1, y: 2 } });
    const b = await computeCacheKey({ ...baseParts(), config: { y: 2, x: 1 } });
    expect(a).toBe(b);
  });

  test.each([
    ['step config', (p: CacheKeyParts) => ({ ...p, config: { prompt: 'Analyse harder.' } })],
    ['pipeline input', (p: CacheKeyParts) => ({ ...p, pipelineInput: { issueId: 2 } })],
    [
      'upstream Output',
      (p: CacheKeyParts) => ({ ...p, upstream: [{ name: 'classify', output: { type: 'chore' } }] }),
    ],
    ['model name', (p: CacheKeyParts) => ({ ...p, model: 'model-b' })],
    ['declared inputs', (p: CacheKeyParts) => ({ ...p, inputs: ['package.json', 'bun.lock'] })],
  ])('change when the %s changes', async (_label, mutate) => {
    const before = await computeCacheKey(baseParts());
    expect(await computeCacheKey(mutate(baseParts()))).not.toBe(before);
  });

  test('change when a declared input file changes', async () => {
    const before = await computeCacheKey(baseParts());
    writeFileSync(join(workspace, 'package.json'), '{"name":"b"}');
    expect(await computeCacheKey(baseParts())).not.toBe(before);
  });

  test('a missing declared input hashes as absent, and appearing changes the key', async () => {
    const parts = { ...baseParts(), inputs: ['not-there.txt'] };
    const before = await computeCacheKey(parts);
    writeFileSync(join(workspace, 'not-there.txt'), 'now it is');
    expect(await computeCacheKey(parts)).not.toBe(before);
  });

  test('expand glob patterns in declared inputs', async () => {
    const parts = { ...baseParts(), inputs: ['*.json'] };
    const before = await computeCacheKey(parts);
    writeFileSync(join(workspace, 'tsconfig.json'), '{}');
    expect(await computeCacheKey(parts)).not.toBe(before);
  });
});

describe('per-step caching', () => {
  const claudeFor = (calls: { n: number }): ClaudeRunner => async () => {
    calls.n++;
    return { text: 'answer', structuredOutput: { viable: true }, sessionId: `s${calls.n}` };
  };

  const pipeline = definePipeline({
    name: 'cached',
    input: z.object({ issueId: z.number() }),
    async run(ctx) {
      const analysis = await ctx.claude({
        name: 'analyze',
        prompt: 'Analyse.',
        output: z.object({ viable: z.boolean() }),
        cache: { inputs: ['package.json'] },
      });
      return analysis.output;
    },
  });

  test('a second run with everything unchanged is a hit', async () => {
    const calls = { n: 0 };
    const cache = memoryCache();
    const opts = { input: { issueId: 1 }, workspace, cache, claude: claudeFor(calls) };

    const first = await pipeline.run(opts);
    const second = await pipeline.run(opts);

    expect(calls.n).toBe(1);
    expect(first.steps[0]!.cacheHit).toBe(false);
    expect(second.steps[0]!.cacheHit).toBe(true);
    expect(second.steps[0]!.cacheKey).toBe(first.steps[0]!.cacheKey!);
    expect(second.output).toEqual({ viable: true });
    expect(second.steps[0]!.sessionId).toBe('s1');
  });

  test('a changed declared input file re-runs the step', async () => {
    const calls = { n: 0 };
    const cache = memoryCache();
    const opts = { input: { issueId: 1 }, workspace, cache, claude: claudeFor(calls) };

    await pipeline.run(opts);
    writeFileSync(join(workspace, 'package.json'), '{"name":"changed"}');
    const second = await pipeline.run(opts);

    expect(calls.n).toBe(2);
    expect(second.steps[0]!.cacheHit).toBe(false);
  });

  test('a changed pipeline input re-runs the step', async () => {
    const calls = { n: 0 };
    const cache = memoryCache();
    await pipeline.run({ input: { issueId: 1 }, workspace, cache, claude: claudeFor(calls) });
    await pipeline.run({ input: { issueId: 2 }, workspace, cache, claude: claudeFor(calls) });
    expect(calls.n).toBe(2);
  });

  test('a changed model re-runs the step', async () => {
    const calls = { n: 0 };
    const cache = memoryCache();
    const base = { input: { issueId: 1 }, workspace, cache, claude: claudeFor(calls) };
    await pipeline.run({ ...base, model: 'model-a' });
    await pipeline.run({ ...base, model: 'model-b' });
    expect(calls.n).toBe(2);
  });

  test('a step that did not opt in is never cached', async () => {
    const calls = { n: 0 };
    const uncached = definePipeline({
      name: 'uncached',
      async run(ctx) {
        await ctx.claude({ name: 'analyze', prompt: 'Analyse.' });
      },
    });
    const cache = memoryCache();
    await uncached.run({ input: undefined, workspace, cache, claude: claudeFor(calls) });
    await uncached.run({ input: undefined, workspace, cache, claude: claudeFor(calls) });
    expect(calls.n).toBe(2);
    expect(cache.store.size).toBe(0);
  });

  test('opting in without a cache adapter is a no-op', async () => {
    const calls = { n: 0 };
    const opts = { input: { issueId: 1 }, workspace, claude: claudeFor(calls) };
    const first = await pipeline.run(opts);
    await pipeline.run(opts);
    expect(calls.n).toBe(2);
    expect(first.steps[0]!.cacheKey).toBeUndefined();
  });

  test('command steps cache their stdout and exit code', async () => {
    const marker = join(workspace, 'counter.txt');
    const counting = definePipeline({
      name: 'counting',
      async run(ctx) {
        const out = await ctx.command({
          name: 'append',
          command: `echo tick >> counter.txt && wc -l < counter.txt`,
          cache: { inputs: ['package.json'] },
        });
        return out.stdout.trim();
      },
    });

    const cache = memoryCache();
    const first = await counting.run({ input: undefined, workspace, cache });
    const second = await counting.run({ input: undefined, workspace, cache });

    expect(first.output).toBe('1');
    expect(second.output).toBe('1');
    expect(second.steps[0]!.cacheHit).toBe(true);
    expect(await Bun.file(marker).text()).toBe('tick\n');
  });

  test('sqliteCache reads back what it wrote', async () => {
    const cache = sqliteCache(':memory:');
    await cache.set('k', { a: 1 });
    expect(await cache.get('k')).toEqual({ a: 1 });
    expect(await cache.get('missing')).toBeUndefined();
    cache.db.close();
  });
});
