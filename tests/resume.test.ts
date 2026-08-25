import { describe, expect, test } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { definePipeline, fake, memoryCache, sqliteStorage } from '../src/index.ts';
import type { ClaudeRunner } from '../src/index.ts';
import { z } from 'zod';

const workspace = () => mkdtemp(join(tmpdir(), 'resume-test-'));

describe('resuming a run', () => {
  test('replays what already succeeded and restarts at the failure', async () => {
    const effects: string[] = [];
    let shouldFail = true;

    const build = () =>
      definePipeline({
        name: 'triage',
        input: z.object({ issue: z.number() }),
        async run(ctx) {
          const verdict = await ctx.claude({
            name: 'classify',
            prompt: `classify issue ${ctx.input.issue}`,
            output: z.object({ label: z.string() }),
          });
          await ctx.step('label', () => {
            effects.push(`labelled:${verdict.output.label}`);
            return verdict.output.label;
          });
          await ctx.step('publish', () => {
            if (shouldFail) throw new Error('registry unavailable');
            effects.push('published');
            return 'ok';
          });
          return verdict.output.label;
        },
      });

    const claude = fake({ classify: { label: 'bug' } });
    const first = await build().run({ input: { issue: 42 }, claude });

    expect(first.status).toBe('failed');
    expect(claude.calls).toHaveLength(1);
    expect(effects).toEqual(['labelled:bug']);

    shouldFail = false;
    const resumed = await build().run({ input: { issue: 42 }, claude, resumeFrom: first });

    expect(resumed.status).toBe('completed');
    expect(resumed.output).toBe('bug');
    // The session and the labelling effect are not repeated; only the failure re-runs.
    expect(claude.calls).toHaveLength(1);
    expect(effects).toEqual(['labelled:bug', 'published']);

    expect(resumed.steps.map((s) => s.replayed === true)).toEqual([true, true, false]);
  });

  test('a step whose declaration changed re-runs', async () => {
    const build = (prompt: string) =>
      definePipeline({
        name: 'changed',
        async run(ctx) {
          await ctx.claude({ name: 'first', prompt, output: z.object({ value: z.string() }) });
        },
      });

    const claude = fake({ first: { value: 'a' } });
    const original = await build('original prompt').run({ input: undefined, claude });
    const changed = await build('a different prompt').run({
      input: undefined,
      claude,
      resumeFrom: original,
    });

    expect(claude.calls).toHaveLength(2);
    expect(changed.steps[0]!.replayed).toBeUndefined();
  });

  test('a downstream step still replays when the step above it produced the same Output', async () => {
    const ran: string[] = [];
    const build = (prompt: string) =>
      definePipeline({
        name: 'same-output',
        async run(ctx) {
          const first = await ctx.claude({
            name: 'first',
            prompt,
            output: z.object({ value: z.string() }),
          });
          await ctx.step('second', () => {
            ran.push('second');
            return `after-${first.output.value}`;
          });
        },
      });

    const claude = fake({ first: { value: 'a' } });
    const original = await build('original prompt').run({ input: undefined, claude });
    expect(ran).toEqual(['second']);

    const changed = await build('a different prompt').run({
      input: undefined,
      claude,
      resumeFrom: original,
    });

    // 'first' re-ran, but a fingerprint covers the Output above a step, not whether
    // that step happened to re-run. Same Output means 'second' has the same work to do.
    expect(claude.calls).toHaveLength(2);
    expect(changed.steps[0]!.replayed).toBeUndefined();
    expect(changed.steps[1]!.replayed).toBe(true);
    expect(ran).toEqual(['second']);
  });

  test('a changed Output above a step breaks the chain and re-runs it', async () => {
    const ran: string[] = [];
    const build = (prompt: string, value: string) =>
      definePipeline({
        name: 'broken-chain',
        async run(ctx) {
          const first = await ctx.claude({
            name: 'first',
            prompt,
            output: z.object({ value: z.string() }),
          });
          await ctx.step('second', () => {
            ran.push(first.output.value);
            return `after-${first.output.value}`;
          });
        },
      });

    const original = await build('original prompt', 'a').run({
      input: undefined,
      claude: fake({ first: { value: 'a' } }),
    });
    expect(ran).toEqual(['a']);

    const changed = await build('a different prompt', 'b').run({
      input: undefined,
      claude: fake({ first: { value: 'b' } }),
      resumeFrom: original,
    });

    expect(changed.steps[0]!.replayed).toBeUndefined();
    expect(changed.steps[1]!.replayed).toBeUndefined();
    expect(ran).toEqual(['a', 'b']);
    expect(changed.steps[1]!.output).toBe('after-b');
  });

  test('editing a code step is enough to re-run it', async () => {
    const seen: string[] = [];
    const build = (suffix: string) =>
      definePipeline({
        name: 'code-identity',
        async run(ctx) {
          await ctx.step('work', () => {
            seen.push(suffix);
            return suffix;
          });
        },
      });

    const first = await build('one').run({ input: undefined });
    const again = await build('one').run({ input: undefined, resumeFrom: first });
    expect(seen).toEqual(['one']);
    expect(again.steps[0]!.replayed).toBe(true);
  });

  test('a run with nothing changed replays every step', async () => {
    const claude = fake({ think: 'an answer' });
    const build = () =>
      definePipeline({
        name: 'idempotent',
        async run(ctx) {
          const said = await ctx.claude({ name: 'think', prompt: 'think' });
          const shell = await ctx.command({ name: 'echo', command: 'echo hello' });
          return `${said.text}:${shell.stdout.trim()}`;
        },
      });

    const first = await build().run({ input: undefined, claude });
    const second = await build().run({ input: undefined, claude, resumeFrom: first });

    expect(second.status).toBe('completed');
    expect(second.output).toBe(first.output);
    expect(second.steps.every((s) => s.replayed === true)).toBe(true);
    expect(claude.calls).toHaveLength(1);
  });

  test('the resumed run wins over the cache, and neither does the work', async () => {
    const cwd = await workspace();
    const cache = memoryCache();
    const build = () =>
      definePipeline({
        name: 'both',
        async run(ctx) {
          return await ctx.command({
            name: 'tick',
            command: 'echo tick >> counter.txt && wc -l < counter.txt',
            cache: {},
          });
        },
      });

    const first = await build().run({ input: undefined, workspace: cwd, cache });
    const resumed = await build().run({ input: undefined, workspace: cwd, cache, resumeFrom: first });

    expect(resumed.steps[0]!.replayed).toBe(true);
    // A replay is not a cache hit; it did not consult the cache at all.
    expect(resumed.steps[0]!.cacheHit).toBe(false);
    expect(resumed.output?.stdout.trim()).toBe('1');
    // The command never ran a second time, so the counter never reached 2.
    expect((await Bun.file(join(cwd, 'counter.txt')).text()).trim()).toBe('tick');
  });

  test('a failed step from the earlier run is never replayed', async () => {
    let attempt = 0;
    const build = () =>
      definePipeline({
        name: 'retry-after-failure',
        async run(ctx) {
          return await ctx.step('flaky', () => {
            attempt += 1;
            if (attempt === 1) throw new Error('first attempt fails');
            return `attempt-${attempt}`;
          });
        },
      });

    const failed = await build().run({ input: undefined });
    expect(failed.status).toBe('failed');

    const resumed = await build().run({ input: undefined, resumeFrom: failed });
    expect(resumed.status).toBe('completed');
    expect(resumed.output).toBe('attempt-2');
    expect(resumed.steps[0]!.replayed).toBeUndefined();
  });

  test('a concurrent group replays as a group', async () => {
    const pipeline = definePipeline({
      name: 'group-resume',
      async run(ctx) {
        const handles = await ctx.commands([
          { name: 'a', command: 'echo a' },
          { name: 'b', command: 'echo b' },
        ]);
        return handles.map((h) => h.stdout.trim());
      },
    });

    const first = await pipeline.run({ input: undefined });
    const resumed = await pipeline.run({ input: undefined, resumeFrom: first });

    expect(resumed.output).toEqual(['a', 'b']);
    expect(resumed.steps.map((s) => s.replayed)).toEqual([true, true]);
  });
});

describe('resuming from a rebuilt record', () => {
  test('a RunResult read back out of sqlite resumes the run it describes', async () => {
    const db = new Database(':memory:');
    const storage = sqliteStorage({ database: db });
    const cwd = await workspace();
    let shouldFail = true;
    const sessions: string[] = [];

    const claude: ClaudeRunner = async (request) => {
      sessions.push(request.stepName);
      return { text: 'an answer', structuredOutput: { label: 'bug' }, sessionId: 'sess-1' };
    };

    const build = () =>
      definePipeline({
        name: 'rebuilt',
        async run(ctx) {
          const verdict = await ctx.claude({
            name: 'classify',
            prompt: 'classify it',
            output: z.object({ label: z.string() }),
          });
          await ctx.step('publish', () => {
            if (shouldFail) throw new Error('not yet');
            return `published:${verdict.output.label}`;
          });
          return verdict.output.label;
        },
      });

    const failed = await build().run({ input: undefined, workspace: cwd, storage, claude });
    expect(failed.status).toBe('failed');
    expect(sessions).toEqual(['classify']);

    // Storage is write-only by ADR 0003, so the consumer reads it with their own SQL
    // and hands the SDK back a record it never loaded itself.
    const rows = db
      .query('SELECT name, kind, status, output, text, session_id, fingerprint FROM steps WHERE run_id = $id ORDER BY idx')
      .all({ $id: failed.id }) as {
      name: string;
      kind: string;
      status: string;
      output: string | null;
      text: string | null;
      session_id: string | null;
      fingerprint: string | null;
    }[];

    const rebuilt = {
      ...failed,
      steps: rows.map((row, index) => ({
        id: `rebuilt-${index}`,
        runId: failed.id,
        index,
        name: row.name,
        kind: row.kind as 'claude' | 'command' | 'code',
        status: row.status as 'completed' | 'failed',
        startedAt: 0,
        output: row.output === null ? undefined : JSON.parse(row.output),
        text: row.text ?? undefined,
        sessionId: row.session_id ?? undefined,
        fingerprint: row.fingerprint ?? undefined,
      })),
    };

    expect(rows[0]!.fingerprint).toBeTruthy();

    shouldFail = false;
    const resumed = await build().run({
      input: undefined,
      workspace: cwd,
      storage,
      claude,
      resumeFrom: rebuilt,
    });

    expect(resumed.status).toBe('completed');
    expect(resumed.output).toBe('bug');
    expect(resumed.steps[0]!.replayed).toBe(true);
    // The session was never opened a second time.
    expect(sessions).toEqual(['classify']);
  });

  test('a database created before fingerprints existed is migrated in place', async () => {
    const db = new Database(':memory:');
    // The steps table exactly as an earlier version of the SDK created it.
    db.run(`
      CREATE TABLE steps (
        id TEXT PRIMARY KEY, run_id TEXT NOT NULL, idx INTEGER NOT NULL, name TEXT NOT NULL,
        kind TEXT NOT NULL, status TEXT NOT NULL, started_at INTEGER NOT NULL,
        finished_at INTEGER, duration_ms INTEGER, output TEXT, text TEXT, error TEXT,
        exit_code INTEGER, session_id TEXT, attempts INTEGER, cache_key TEXT, cache_hit INTEGER
      );
    `);

    const storage = sqliteStorage({ database: db });
    const columns = (db.query('PRAGMA table_info(steps)').all() as { name: string }[]).map((c) => c.name);
    expect(columns).toContain('fingerprint');
    expect(columns).toContain('replayed');

    const pipeline = definePipeline({
      name: 'migrated',
      async run(ctx) {
        return await ctx.step('work', () => 'value');
      },
    });

    const result = await pipeline.run({ input: undefined, storage });
    expect(result.status).toBe('completed');
    expect(
      (db.query('SELECT fingerprint FROM steps').get() as { fingerprint: string | null }).fingerprint,
    ).toBeTruthy();
  });
});
