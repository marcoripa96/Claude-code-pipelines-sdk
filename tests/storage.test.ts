import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { z } from 'zod';
import { definePipeline, sqliteStorage } from '../src/index.ts';
import type { ClaudeRunner, StorageAdapter } from '../src/index.ts';

const claude: ClaudeRunner = async (_request, onMessage) => {
  onMessage({ type: 'assistant', text: 'thinking' } as never);
  onMessage({ type: 'result', subtype: 'success' } as never);
  return { finalMessage: 'done', structuredOutput: { ok: true }, sessionId: 'sess-1' };
};

describe('sqlite storage adapter', () => {
  test('round-trips a full run', async () => {
    const db = new Database(':memory:');
    const storage = sqliteStorage({ database: db });
    const workspace = mkdtempSync(join(tmpdir(), 'pipelines-store-'));

    const pipeline = definePipeline({
      name: 'stored',
      input: z.object({ issueId: z.number() }),
      steps: ['ask', 'shell', 'code'],
      async run(ctx) {
        const ask = await ctx.claude({
          name: 'ask',
          prompt: 'Decide.',
          output: z.object({ ok: z.boolean() }),
        });
        await ctx.command({ name: 'shell', command: 'echo hi' });
        await ctx.step('code', () => ({ seen: ask.output.ok }));
        return { finished: true };
      },
    });

    const result = await pipeline.run({
      input: { issueId: 42 },
      workspace,
      model: 'test-model',
      storage,
      claude,
    });

    const run = db.query('SELECT * FROM runs WHERE id = ?').get(result.id) as Record<string, unknown>;
    expect(run.pipeline).toBe('stored');
    expect(run.status).toBe('completed');
    expect(run.workspace).toBe(workspace);
    expect(run.model).toBe('test-model');
    expect(JSON.parse(run.input as string)).toEqual({ issueId: 42 });
    expect(JSON.parse(run.output as string)).toEqual({ finished: true });
    expect(run.duration_ms as number).toBeGreaterThanOrEqual(0);
    expect(run.error).toBeNull();

    const steps = db
      .query('SELECT * FROM steps WHERE run_id = ? ORDER BY idx')
      .all(result.id) as Record<string, unknown>[];
    expect(steps.map((s) => s.name)).toEqual(['ask', 'shell', 'code']);
    expect(steps.map((s) => s.kind)).toEqual(['claude', 'command', 'code']);
    expect(steps.every((s) => s.status === 'completed')).toBe(true);
    expect(steps[0]!.session_id).toBe('sess-1');
    expect(JSON.parse(steps[0]!.output as string)).toEqual({ ok: true });
    expect(steps[0]!.final_message).toBe('done');
    expect(steps[1]!.exit_code).toBe(0);
    expect(JSON.parse(steps[2]!.output as string)).toEqual({ seen: true });

    const messages = db
      .query('SELECT * FROM messages WHERE step_id = ? ORDER BY seq')
      .all(steps[0]!.id as string) as Record<string, unknown>[];
    expect(messages).toHaveLength(2);
    expect(messages.map((m) => m.type)).toEqual(['assistant', 'result']);
    expect(JSON.parse(messages[0]!.body as string)).toEqual({ type: 'assistant', text: 'thinking' });

    db.close();
  });

  test('records a halted run with its skipped steps', async () => {
    const db = new Database(':memory:');
    const pipeline = definePipeline({
      name: 'halted',
      steps: ['first', 'second'],
      async run(ctx) {
        await ctx.step('first', () => 1);
        ctx.halt('enough');
      },
    });

    const result = await pipeline.run({
      input: undefined,
      storage: sqliteStorage({ database: db }),
    });

    const run = db.query('SELECT * FROM runs WHERE id = ?').get(result.id) as Record<string, unknown>;
    expect(run.status).toBe('halted');
    expect(run.halt_reason).toBe('enough');

    const statuses = (
      db.query('SELECT name, status FROM steps WHERE run_id = ?').all(result.id) as Record<
        string,
        unknown
      >[]
    ).map((s) => `${s.name}:${s.status}`);
    expect(statuses.sort()).toEqual(['first:completed', 'second:skipped']);
    db.close();
  });

  test('records a failed run and its failed step', async () => {
    const db = new Database(':memory:');
    const pipeline = definePipeline({
      name: 'broken',
      async run(ctx) {
        await ctx.step('boom', () => {
          throw new Error('kaboom');
        });
      },
    });

    const result = await pipeline.run({
      input: undefined,
      storage: sqliteStorage({ database: db }),
    });

    const run = db.query('SELECT * FROM runs WHERE id = ?').get(result.id) as Record<string, unknown>;
    expect(run.status).toBe('failed');
    expect(run.error as string).toContain('kaboom');
    const step = db.query('SELECT * FROM steps WHERE run_id = ?').get(result.id) as Record<
      string,
      unknown
    >;
    expect(step.status).toBe('failed');
    expect(step.error as string).toContain('kaboom');
    db.close();
  });

  test('never deletes: a second run leaves the first in place', async () => {
    const db = new Database(':memory:');
    const storage = sqliteStorage({ database: db });
    const pipeline = definePipeline({
      name: 'twice',
      async run(ctx) {
        await ctx.step('only', () => 1);
      },
    });

    await pipeline.run({ input: undefined, storage });
    await pipeline.run({ input: undefined, storage });

    expect((db.query('SELECT COUNT(*) AS n FROM runs').get() as { n: number }).n).toBe(2);
    expect((db.query('SELECT COUNT(*) AS n FROM steps').get() as { n: number }).n).toBe(2);
    db.close();
  });

  test('a storage failure surfaces as a failed run', async () => {
    const storage: StorageAdapter = {
      runStarted: () => {},
      stepStarted: () => {
        throw new Error('disk full');
      },
      messageAppended: () => {},
      stepFinished: () => {},
      runFinished: () => {},
    };
    const pipeline = definePipeline({
      name: 'unstorable',
      async run(ctx) {
        await ctx.step('only', () => 1);
      },
    });

    const result = await pipeline.run({ input: undefined, storage });
    expect(result.status).toBe('failed');
    expect(result.error).toContain('disk full');
  });
});
