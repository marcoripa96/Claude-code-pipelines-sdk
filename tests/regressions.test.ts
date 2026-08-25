import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import {
  computeCacheKey,
  createClaudeRunner,
  definePipeline,
  fake,
  memoryCache,
  sqliteStorage,
} from '../src/index.ts';
import type { CacheKeyParts, ClaudeRunner, StepRecord, StorageAdapter } from '../src/index.ts';

const workspace = mkdtempSync(join(tmpdir(), 'pipelines-regressions-'));

function parts(overrides: Partial<CacheKeyParts> = {}): CacheKeyParts {
  return {
    pipeline: 'p',
    stepName: 's',
    kind: 'claude',
    config: {},
    inputs: [],
    workspace,
    pipelineInput: {},
    upstream: [],
    model: 'm',
    ...overrides,
  };
}

describe('cache keys distinguish values JSON.stringify would flatten', () => {
  test('two different Dates do not collide', async () => {
    const a = await computeCacheKey(parts({ pipelineInput: { at: new Date('2026-01-01') } }));
    const b = await computeCacheKey(parts({ pipelineInput: { at: new Date('2026-08-25') } }));
    expect(a).not.toBe(b);
  });

  test('the same Date is stable', async () => {
    const a = await computeCacheKey(parts({ pipelineInput: { at: new Date('2026-01-01') } }));
    const b = await computeCacheKey(parts({ pipelineInput: { at: new Date('2026-01-01') } }));
    expect(a).toBe(b);
  });

  test('Maps, Sets and plain objects with the same contents do not collide', async () => {
    const keys = await Promise.all(
      [
        new Map([['a', 1]]),
        new Map([['a', 2]]),
        new Set(['a']),
        new Set(['b']),
        { a: 1 },
        {},
      ].map((value) => computeCacheKey(parts({ pipelineInput: { value } }))),
    );
    expect(new Set(keys).size).toBe(keys.length);
  });

  test('Map and Set order does not change the key', async () => {
    const a = await computeCacheKey(parts({ pipelineInput: { v: new Set(['a', 'b']) } }));
    const b = await computeCacheKey(parts({ pipelineInput: { v: new Set(['b', 'a']) } }));
    expect(a).toBe(b);
  });

  test('two class instances with the same fields do not collide', async () => {
    class Cat {
      constructor(public name: string) {}
    }
    class Dog {
      constructor(public name: string) {}
    }
    const a = await computeCacheKey(parts({ pipelineInput: { pet: new Cat('rex') } }));
    const b = await computeCacheKey(parts({ pipelineInput: { pet: new Dog('rex') } }));
    expect(a).not.toBe(b);
  });

  test('NaN, Infinity and null do not collide', async () => {
    const keys = await Promise.all(
      [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, null].map((v) =>
        computeCacheKey(parts({ pipelineInput: { v } })),
      ),
    );
    expect(new Set(keys).size).toBe(4);
  });

  test('a value that references itself is a clear error, not a silent collision', async () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    await expect(computeCacheKey(parts({ pipelineInput: cyclic }))).rejects.toThrow('references itself');
  });
});

describe('cache keys cover every declared option', () => {
  const claudeFor = (calls: { n: number }): ClaudeRunner => async () => {
    calls.n++;
    return { text: 'answer' };
  };

  const withMcp = (mcpServers: Record<string, unknown>) =>
    definePipeline({
      name: 'mcp',
      async run(ctx) {
        await ctx.claude({
          name: 'ask',
          prompt: 'go',
          mcpServers,
          cache: { inputs: [] },
        });
      },
    });

  test('changing mcpServers re-runs the step', async () => {
    const calls = { n: 0 };
    const cache = memoryCache();
    const run = { input: undefined, workspace, cache, claude: claudeFor(calls) };

    await withMcp({ tracker: { command: 'a' } }).run(run);
    await withMcp({ tracker: { command: 'b' } }).run(run);

    expect(calls.n).toBe(2);
  });

  test('an unchanged mcpServers still hits', async () => {
    const calls = { n: 0 };
    const cache = memoryCache();
    const run = { input: undefined, workspace, cache, claude: claudeFor(calls) };

    await withMcp({ tracker: { command: 'a' } }).run(run);
    await withMcp({ tracker: { command: 'a' } }).run(run);

    expect(calls.n).toBe(1);
  });
});

describe('a declared input directory', () => {
  test('hashes everything beneath it, like an explicit glob would', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pipelines-dir-'));
    mkdirSync(join(root, 'src/nested'), { recursive: true });
    writeFileSync(join(root, 'src/a.ts'), 'one');

    const declared = parts({ workspace: root, inputs: ['src'] });
    const before = await computeCacheKey(declared);

    writeFileSync(join(root, 'src/nested/b.ts'), 'two');
    const afterAdding = await computeCacheKey(declared);
    expect(afterAdding).not.toBe(before);

    writeFileSync(join(root, 'src/a.ts'), 'one changed');
    expect(await computeCacheKey(declared)).not.toBe(afterAdding);

    // A file outside the declaration is still none of its business.
    const unrelated = await computeCacheKey(declared);
    writeFileSync(join(root, 'README.md'), 'hello');
    expect(await computeCacheKey(declared)).toBe(unrelated);
  });

  test('a trailing slash means the same thing', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pipelines-dir2-'));
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src/a.ts'), 'one');
    expect(await computeCacheKey(parts({ workspace: root, inputs: ['src/'] }))).toBe(
      await computeCacheKey(parts({ workspace: root, inputs: ['src'] })),
    );
  });
});

describe('a storage adapter outlives its runs', () => {
  const pipeline = definePipeline({
    name: 'reusable',
    async run(ctx) {
      await ctx.step('only', () => 1);
    },
  });

  test('one sqliteStorage serves any number of runs', async () => {
    const db = new Database(':memory:');
    const storage = sqliteStorage({ database: db });

    const first = await pipeline.run({ input: undefined, storage });
    const second = await pipeline.run({ input: undefined, storage });

    expect(first.status).toBe('completed');
    expect(second.status).toBe('completed');
    expect((db.query('SELECT COUNT(*) AS n FROM runs').get() as { n: number }).n).toBe(2);
    db.close();
  });

  test('an adapter that opened its own file is not closed underneath the caller', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'pipelines-db-')), 'runs.sqlite');
    const storage = sqliteStorage(path);

    await pipeline.run({ input: undefined, storage });
    await pipeline.run({ input: undefined, storage });

    expect((storage.db.query('SELECT COUNT(*) AS n FROM steps').get() as { n: number }).n).toBe(2);
    storage.db.close();
  });

  test('reusing a run id is a clear error', async () => {
    const db = new Database(':memory:');
    const storage = sqliteStorage({ database: db });
    const runId = crypto.randomUUID();

    await pipeline.run({ input: undefined, storage, runId });
    const second = await pipeline.run({ input: undefined, storage, runId });

    expect(second.status).toBe('failed');
    expect(second.error).toContain('must be unique');
    expect((db.query('SELECT COUNT(*) AS n FROM runs').get() as { n: number }).n).toBe(1);
    db.close();
  });

  test('an adapter that throws on runStarted gives a failed run, not a thrown call', async () => {
    const storage: StorageAdapter = {
      runStarted: () => {
        throw new Error('disk full');
      },
      stepStarted: () => {},
      messageAppended: () => {},
      stepFinished: () => {},
      runFinished: () => {},
    };

    const result = await pipeline.run({ input: undefined, storage });
    expect(result.status).toBe('failed');
    expect(result.error).toContain('disk full');
  });
});

describe('fake() is reusable across runs', () => {
  const pipeline = definePipeline({
    name: 'retrying',
    async run(ctx) {
      const answer = await ctx.claude({
        name: 'ask',
        prompt: 'go',
        output: z.object({ ok: z.boolean() }),
        retry: 1,
      });
      return answer.output;
    },
  });

  test('a hoisted runner starts each run from the first fixture', async () => {
    const claude = fake({ ask: [new Error('session died'), { ok: true }] });

    const first = await pipeline.run({ input: undefined, claude });
    const second = await pipeline.run({ input: undefined, claude });

    expect(first.status).toBe('completed');
    expect(second.status).toBe('completed');
    expect(claude.calls).toHaveLength(4);
  });

  test('two executions of the same step name in one run each get the whole list', async () => {
    const twice = definePipeline({
      name: 'twice',
      async run(ctx) {
        const a = await ctx.claude({ name: 'ask', prompt: 'go', retry: 1 });
        const b = await ctx.claude({ name: 'ask', prompt: 'go again', retry: 1 });
        return [a.text, b.text];
      },
    });

    const claude = fake({ ask: [new Error('died'), 'recovered'] });
    const result = await twice.run({ input: undefined, claude });

    expect(result.status).toBe('completed');
    expect(result.output).toEqual(['recovered', 'recovered']);
  });
});

describe('event listeners cannot take a run down', () => {
  const pipeline = definePipeline({
    name: 'listeners',
    steps: ['only', 'skipped'],
    async run(ctx) {
      await ctx.step('only', () => 1);
      ctx.halt('enough');
    },
  });

  test('an error listener that itself throws is contained', async () => {
    const result = await pipeline.run({
      input: undefined,
      on: {
        stepStarted: () => {
          throw new Error('listener blew up');
        },
        error: () => {
          throw new Error('and so did the error listener');
        },
      },
    });

    expect(result.status).toBe('halted');
  });

  test('every stepFinished is preceded by a stepStarted, skipped steps included', async () => {
    const seen: string[] = [];
    await pipeline.run({
      input: undefined,
      on: {
        stepStarted: (s: StepRecord) => void seen.push(`+${s.name}`),
        stepFinished: (s: StepRecord) => void seen.push(`-${s.name}`),
      },
    });

    expect(seen).toEqual(['+only', '-only', '+skipped', '-skipped']);
  });
});

describe('the default Claude runner', () => {
  const resultMessage = (extra: Record<string, unknown> = {}) => ({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'the answer',
    session_id: 'sess-1',
    total_cost_usd: 0.01,
    ...extra,
  });

  const queryReturning = (messages: unknown[]) =>
    (() => (async function* () {
      for (const message of messages) yield message;
    })()) as never;

  test('reads text and structured_output off the result message', async () => {
    const runner = createClaudeRunner({
      query: queryReturning([resultMessage({ structured_output: { ok: true } })]),
    });

    const response = await runner(
      { stepName: 's' } as never,
      () => {},
    );

    expect(response).toMatchObject({
      text: 'the answer',
      structuredOutput: { ok: true },
      sessionId: 'sess-1',
    });
  });

  test('a session with no result message is an error, not an empty Output', async () => {
    const runner = createClaudeRunner({ query: queryReturning([{ type: 'assistant' }]) });
    await expect(runner({ stepName: 's' } as never, () => {})).rejects.toThrow(
      'ended without a result message',
    );
  });

  test('an error subtype names the terminal reason', async () => {
    const runner = createClaudeRunner({
      query: queryReturning([
        {
          type: 'result',
          subtype: 'error_max_structured_output_retries',
          is_error: true,
          errors: ['gave up'],
          terminal_reason: 'structured_output_retry_exhausted',
        },
      ]),
    });

    await expect(runner({ stepName: 'classify' } as never, () => {})).rejects.toThrow(
      'structured_output_retry_exhausted',
    );
  });

  test('the abort listener comes off the run signal when the session ends', async () => {
    const controller = new AbortController();
    let added = 0;
    let removed = 0;
    const signal = new Proxy(controller.signal, {
      get(target, prop, receiver) {
        if (prop === 'addEventListener') {
          return (...args: unknown[]) => {
            added++;
            return Reflect.get(target, prop, receiver).apply(target, args as never);
          };
        }
        if (prop === 'removeEventListener') {
          return (...args: unknown[]) => {
            removed++;
            return Reflect.get(target, prop, receiver).apply(target, args as never);
          };
        }
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

    const runner = createClaudeRunner({ query: queryReturning([resultMessage()]) });
    for (let i = 0; i < 3; i++) {
      await runner({ stepName: 's', signal } as never, () => {});
    }

    expect(added).toBe(3);
    expect(removed).toBe(3);
  });
});
