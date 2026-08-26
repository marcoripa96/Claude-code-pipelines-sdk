import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { appendFile, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { z } from 'zod';
import {
  IndeterminateStepError,
  RunNotFoundError,
  RunTakenError,
  definePipeline,
  fake,
  sqliteStorage,
} from '../src/index.ts';
import type { RunResult, StepRecord, StorageAdapter } from '../src/index.ts';
import { crashingClaude, crashingPipeline } from './fixtures/crashing-pipeline.ts';

const workspace = () => mkdtemp(join(tmpdir(), 'durable-test-'));
const FIXTURE = join(import.meta.dir, 'fixtures', 'crashing-run.ts');

/** Runs the fixture pipeline in a child process that SIGKILLs itself mid-step. */
async function crash(mode: 'before' | 'after'): Promise<{
  runId: string;
  db: string;
  cwd: string;
}> {
  const cwd = await workspace();
  const db = join(cwd, 'runs.sqlite');
  const runId = crypto.randomUUID();
  const child = Bun.spawn(['bun', FIXTURE], {
    env: { ...process.env, RUN_DB: db, WORKSPACE: cwd, RUN_ID: runId, CRASH_MODE: mode },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  await child.exited;
  // Killed, not exited: a run that ended normally would prove nothing.
  expect(child.signalCode).toBe('SIGKILL');
  return { runId, db, cwd };
}

describe('a run killed mid-step', () => {
  test('leaves a journal that names the work that was in flight', async () => {
    const { runId, db } = await crash('before');
    const storage = sqliteStorage({ path: db });

    const prior = storage.readRun(runId)!;
    expect(prior.status).toBe('running');
    expect(prior.finishedAt).toBeUndefined();

    const steps = Object.fromEntries(prior.steps.map((s) => [s.name, s]));
    expect(steps.prepare!.status).toBe('completed');
    expect(steps.classify!.status).toBe('completed');
    // The point of ADR 0009: the step the crash interrupted is identifiable, not an
    // anonymous `running` row that a later run would silently redo.
    expect(steps.ship!.status).toBe('running');
    expect(steps.ship!.fingerprint).toBeTruthy();
    expect(steps.ship!.finishedAt).toBeUndefined();

    storage.db.close();
  });

  test('is recovered by another process, which does not repeat what already happened', async () => {
    const { runId, db, cwd } = await crash('before');
    const storage = sqliteStorage({ path: db });
    const effects = join(cwd, 'shipped.log');
    const claude = crashingClaude();

    // The crash happened on the way in, so nothing was shipped.
    expect(existsSync(effects)).toBe(false);

    const recovered = await crashingPipeline({
      async ship() {
        await appendFile(effects, 'shipped\n');
        return 'shipped';
      },
      // Nothing landed, so asking finds nothing and the step runs.
      reconcile: async () => (existsSync(effects) ? 'shipped' : undefined),
    }).recover({ runId, storage, claude });

    expect(recovered.status).toBe('completed');
    expect(recovered.output).toBe('ready:bug:shipped');
    // Input and workspace came from the crashed run's own record.
    expect(recovered.workspace).toBe(cwd);
    expect(recovered.input).toEqual({ marker: 'm1' });

    const steps = Object.fromEntries(recovered.steps.map((s) => [s.name, s]));
    expect(steps.prepare!.replayed).toBe(true);
    expect(steps.classify!.replayed).toBe(true);
    // The session was never opened again.
    expect(claude.calls).toHaveLength(0);
    expect(steps.ship!.replayed).toBeUndefined();
    expect(steps.ship!.recovered).toBe('rerun');
    expect((await readFile(effects, 'utf8')).trim()).toBe('shipped');

    storage.db.close();
  });

  test('an effect that landed before the crash is adopted, not repeated', async () => {
    const { runId, db, cwd } = await crash('after');
    const storage = sqliteStorage({ path: db });
    const effects = join(cwd, 'shipped.log');

    // The effect happened; the process died before anything could record that.
    expect((await readFile(effects, 'utf8')).trim()).toBe('shipped');

    const recovered = await crashingPipeline({
      async ship() {
        await appendFile(effects, 'shipped\n');
        return 'shipped';
      },
      reconcile: async () => (existsSync(effects) ? 'shipped' : undefined),
    }).recover({ runId, storage, claude: crashingClaude() });

    expect(recovered.status).toBe('completed');
    const ship = recovered.steps.find((s) => s.name === 'ship')!;
    expect(ship.recovered).toBe('reconciled');
    // One line, not two: the whole point.
    expect((await readFile(effects, 'utf8')).trim().split('\n')).toHaveLength(1);

    storage.db.close();
  });

  test('a code step with no way to know refuses to guess', async () => {
    const { runId, db, cwd } = await crash('after');
    const storage = sqliteStorage({ path: db });
    const effects = join(cwd, 'shipped.log');

    const refused = await crashingPipeline({
      async ship() {
        await appendFile(effects, 'shipped\n');
        return 'shipped';
      },
      // No reconcile, and `ctx.step` defaults to `onCrash: 'fail'`.
    }).recover({ runId, storage, claude: crashingClaude() });

    expect(refused.status).toBe('failed');
    expect(refused.cause).toBeInstanceOf(Error);
    const cause = (refused.cause as { cause?: unknown }).cause;
    expect(cause).toBeInstanceOf(IndeterminateStepError);
    expect((cause as IndeterminateStepError).stepName).toBe('ship');
    // Nothing was repeated while it stopped to ask.
    expect((await readFile(effects, 'utf8')).trim().split('\n')).toHaveLength(1);

    storage.db.close();
  });

  test('a step told repeating is safe is repeated', async () => {
    const { runId, db, cwd } = await crash('after');
    const storage = sqliteStorage({ path: db });
    const effects = join(cwd, 'shipped.log');

    const recovered = await crashingPipeline({
      async ship() {
        await appendFile(effects, 'shipped\n');
        return 'shipped';
      },
      onCrash: 'rerun',
    }).recover({ runId, storage, claude: crashingClaude() });

    expect(recovered.status).toBe('completed');
    expect(recovered.steps.find((s) => s.name === 'ship')!.recovered).toBe('rerun');
    expect((await readFile(effects, 'utf8')).trim().split('\n')).toHaveLength(2);

    storage.db.close();
  });

  test('the run it took over is marked superseded, and stops being offered', async () => {
    const { runId, db, cwd } = await crash('before');
    const storage = sqliteStorage({ path: db });
    const effects = join(cwd, 'shipped.log');

    expect(storage.resumable({ staleMs: 0 }).map((r) => r.id)).toEqual([runId]);

    const recovered = await crashingPipeline({
      async ship() {
        await appendFile(effects, 'shipped\n');
        return 'shipped';
      },
      onCrash: 'rerun',
    }).recover({ runId, storage, claude: crashingClaude() });

    expect(recovered.id).not.toBe(runId);
    expect(storage.readRun(runId)!.status).toBe('superseded');
    expect(storage.resumable({ staleMs: 0 })).toHaveLength(0);

    storage.db.close();
  });
});

describe('the journal records intent', () => {
  test('a step is announced with the fingerprint of the work it is about to do', async () => {
    const started: StepRecord[] = [];
    const spy: StorageAdapter = {
      runStarted() {},
      stepStarted(step) {
        // Snapshotted: the record is mutated in place as the step proceeds.
        started.push({ ...step });
      },
      messageAppended() {},
      stepFinished() {},
      runFinished() {},
    };

    const pipeline = definePipeline({
      name: 'intent',
      async run(ctx) {
        await ctx.step('one', () => 'a');
        await ctx.claude({ name: 'two', prompt: 'think' });
        await ctx.command({ name: 'three', command: 'echo hi' });
      },
    });

    const result = await pipeline.run({
      input: undefined,
      storage: spy,
      claude: fake({ two: 'answered' }),
    });

    expect(result.status).toBe('completed');
    expect(started.map((s) => s.name)).toEqual(['one', 'two', 'three']);
    for (const step of started) {
      expect(step.status).toBe('running');
      expect(step.fingerprint).toBeTruthy();
    }
    // The fingerprint written at the start is the one the step finished with.
    expect(started.map((s) => s.fingerprint)).toEqual(result.steps.map((s) => s.fingerprint));
  });

  test('a step whose identity cannot be computed is still recorded as a step', async () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    const pipeline = definePipeline({
      name: 'unidentifiable',
      async run(ctx) {
        await ctx.command({ name: 'loop', command: 'echo hi', cache: {}, env: circular as never });
      },
    });

    const seen: string[] = [];
    const result = await pipeline.run({
      input: undefined,
      on: {
        stepStarted: (s) => void seen.push(`started:${s.name}`),
        stepFinished: (s) => void seen.push(`finished:${s.name}:${s.status}`),
      },
    });

    expect(result.status).toBe('failed');
    // Every stepStarted a listener sees still has its stepFinished, so nothing is left
    // looking as though it might be running somewhere.
    expect(seen).toEqual(['started:loop', 'finished:loop:failed']);
    expect(result.steps[0]!.status).toBe('failed');
  });
});

describe('finding runs to recover', () => {
  test('a run is offered once its lease goes quiet, and not before', async () => {
    const db = new Database(':memory:');
    const storage = sqliteStorage({ database: db });
    const cwd = await workspace();

    const pipeline = definePipeline({
      name: 'leased',
      async run(ctx) {
        return await ctx.step('work', () => 'done');
      },
    });
    await pipeline.run({ input: undefined, workspace: cwd, storage });

    // A finished run is never resumable, however old.
    expect(storage.resumable({ staleMs: 0 })).toHaveLength(0);

    // A run that stopped without finishing: the row a crash leaves behind.
    const stranded = crypto.randomUUID();
    storage.runStarted({
      id: stranded,
      pipeline: 'leased',
      status: 'running',
      workspace: cwd,
      input: null,
      startedAt: Date.now(),
    });

    expect(storage.resumable({ staleMs: 60_000 })).toHaveLength(0);
    expect(storage.resumable({ staleMs: 0 }).map((r) => r.id)).toEqual([stranded]);
    expect(storage.resumable({ staleMs: 0, pipeline: 'other' })).toHaveLength(0);

    // A live owner renews the lease, and the run stops being on offer.
    storage.heartbeat(stranded, Date.now() + 60_000);
    expect(storage.resumable({ staleMs: 0 })).toHaveLength(0);

    db.close();
  });

  test('a live run renews its own lease', async () => {
    const db = new Database(':memory:');
    const storage = sqliteStorage({ database: db });
    const beats: number[] = [];
    const watched = {
      ...storage,
      heartbeat(runId: string, at: number) {
        beats.push(at);
        storage.heartbeat(runId, at);
      },
    };

    const pipeline = definePipeline({
      name: 'heartbeats',
      async run(ctx) {
        await ctx.step('slow', () => Bun.sleep(60));
        return 'done';
      },
    });

    const result = await pipeline.run({ input: undefined, storage: watched, heartbeatMs: 15 });
    expect(result.status).toBe('completed');
    // One on start, plus at least one renewal while the slow step ran.
    expect(beats.length).toBeGreaterThan(1);
    db.close();
  });
});

describe('two supervisors racing for the same abandoned run', () => {
  test('only one takes it over; the other stops instead of duplicating its work', async () => {
    const db = new Database(':memory:');
    const storage = sqliteStorage({ database: db });
    const cwd = await workspace();
    const effects: string[] = [];

    const pipeline = definePipeline({
      name: 'contested',
      async run(ctx) {
        return await ctx.step('deliver', () => {
          effects.push('delivered');
          return 'delivered';
        }, { onCrash: 'rerun' });
      },
    });

    // The row a crash leaves behind, and the record both supervisors read before either
    // of them acted on it.
    const stranded = crypto.randomUUID();
    storage.runStarted({
      id: stranded,
      pipeline: 'contested',
      status: 'running',
      workspace: cwd,
      input: null,
      startedAt: Date.now(),
    });
    const seen = storage.readRun(stranded)!;
    expect(seen.status).toBe('running');

    const winner = await pipeline.run({ input: undefined, workspace: cwd, storage, resumeFrom: seen });
    const loser = await pipeline.run({ input: undefined, workspace: cwd, storage, resumeFrom: seen });

    expect(winner.status).toBe('completed');
    expect(loser.status).toBe('failed');
    expect(loser.cause).toBeInstanceOf(RunTakenError);
    expect((loser.cause as RunTakenError).runId).toBe(stranded);
    // The loser stopped before doing any of the work the winner was already doing.
    expect(effects).toEqual(['delivered']);
    expect(loser.steps).toHaveLength(0);
    expect(storage.readRun(stranded)!.status).toBe('superseded');

    db.close();
  });

  test('an adapter that cannot arbitrate is trusted', async () => {
    const cwd = await workspace();
    const superseded: string[] = [];
    // A consumer's own adapter, recording the takeover without reporting a winner.
    const storage: StorageAdapter = {
      runStarted() {},
      stepStarted() {},
      messageAppended() {},
      stepFinished() {},
      runFinished() {},
      runSuperseded(previous) {
        superseded.push(previous);
      },
    };

    const result = await definePipeline({
      name: 'unarbitrated',
      run: (ctx) => ctx.step('work', () => 'value'),
    }).run({
      input: undefined,
      workspace: cwd,
      storage,
      resumeFrom: {
        id: 'prior-run',
        pipeline: 'unarbitrated',
        status: 'running',
        workspace: cwd,
        input: undefined,
        startedAt: 0,
        steps: [],
      },
    });

    expect(result.status).toBe('completed');
    expect(superseded).toEqual(['prior-run']);
  });
});

describe('resuming by run id', () => {
  test('a run id is loaded through the adapter', async () => {
    const db = new Database(':memory:');
    const storage = sqliteStorage({ database: db });
    let shouldFail = true;

    const build = () =>
      definePipeline({
        name: 'by-id',
        async run(ctx) {
          const value = await ctx.step('first', () => 'value');
          await ctx.step('second', () => {
            if (shouldFail) throw new Error('not yet');
            return `${value}!`;
          });
          return value;
        },
      });

    const failed = await build().run({ input: undefined, storage });
    expect(failed.status).toBe('failed');

    shouldFail = false;
    const resumed = await build().run({ input: undefined, storage, resumeFrom: failed.id });
    expect(resumed.status).toBe('completed');
    expect(resumed.steps[0]!.replayed).toBe(true);
    db.close();
  });

  test('an unknown run id says so', async () => {
    const db = new Database(':memory:');
    const storage = sqliteStorage({ database: db });
    const pipeline = definePipeline({ name: 'missing', run: () => 'x' });

    expect(pipeline.run({ input: undefined, storage, resumeFrom: 'nope' })).rejects.toThrow(
      RunNotFoundError,
    );
    expect(pipeline.recover({ runId: 'nope', storage })).rejects.toThrow(RunNotFoundError);
    db.close();
  });

  test('a run id with no adapter that can read it is refused, not guessed at', async () => {
    const pipeline = definePipeline({ name: 'unreadable', run: () => 'x' });
    expect(pipeline.run({ input: undefined, resumeFrom: 'some-id' })).rejects.toThrow(
      /no storage adapter that can read/,
    );
  });
});

describe('reading a run back', () => {
  test('what comes out of storage is what resume needs', async () => {
    const db = new Database(':memory:');
    const storage = sqliteStorage({ database: db });
    const cwd = await workspace();

    const pipeline = definePipeline({
      name: 'roundtrip',
      input: z.object({ a: z.number() }),
      steps: ['code', 'session', 'shell', 'never'],
      async run(ctx) {
        await ctx.step('code', () => ({ nested: [1, 'two', null] }));
        await ctx.claude({ name: 'session', prompt: 'think' });
        await ctx.command({ name: 'shell', command: 'echo out' });
        ctx.halt('nothing left to do');
      },
    });

    const original = await pipeline.run({
      input: { a: 1 },
      workspace: cwd,
      model: 'a-model',
      storage,
      claude: fake({ session: 'an answer' }),
    });

    const read = storage.readRun(original.id)!;
    expect(read.status).toBe('halted');
    expect(read.haltReason).toBe('nothing left to do');
    expect(read.input).toEqual({ a: 1 });
    expect(read.model).toBe('a-model');
    expect(read.workspace).toBe(cwd);
    expect(read.error).toBeUndefined();

    expect(read.steps.map((s) => [s.name, s.status, s.kind])).toEqual(
      original.steps.map((s) => [s.name, s.status, s.kind]),
    );
    expect(read.steps[0]!.output).toEqual({ nested: [1, 'two', null] });
    expect(read.steps[1]!.finalMessage).toBe('an answer');
    expect(read.steps.map((s) => s.fingerprint)).toEqual(original.steps.map((s) => s.fingerprint));
    // The skipped step a halt recorded survives the round trip too.
    expect(read.steps.find((s) => s.name === 'never')!.status).toBe('skipped');

    db.close();
  });

  test('a run that returned null reads back as null, not as nothing', async () => {
    const db = new Database(':memory:');
    const storage = sqliteStorage({ database: db });
    const original = await definePipeline({
      name: 'null-run-output',
      run: () => null,
    }).run({ input: undefined, storage });

    const read = storage.readRun(original.id)!;
    expect(read.output).toBeNull();
    expect('output' in read).toBe(true);
    db.close();
  });

  test('a step that returned null replays as null, not as nothing', async () => {
    const db = new Database(':memory:');
    const storage = sqliteStorage({ database: db });
    const pipeline = definePipeline({
      name: 'nulls',
      async run(ctx) {
        return await ctx.step('nothing', () => null);
      },
    });

    const original = await pipeline.run({ input: undefined, storage });
    const read = storage.readRun(original.id)! as RunResult;
    expect(read.steps[0]!.output).toBeNull();
    expect('output' in read.steps[0]!).toBe(true);
    db.close();
  });

  test('a database written before durability existed is migrated in place', async () => {
    const db = new Database(':memory:');
    db.run(`
      CREATE TABLE runs (
        id TEXT PRIMARY KEY, pipeline TEXT NOT NULL, status TEXT NOT NULL,
        workspace TEXT NOT NULL, input TEXT, model TEXT, started_at INTEGER NOT NULL,
        finished_at INTEGER, duration_ms INTEGER, output TEXT, halt_reason TEXT, error TEXT
      );
    `);
    const storage = sqliteStorage({ database: db });
    const columns = (db.query('PRAGMA table_info(runs)').all() as { name: string }[]).map((c) => c.name);
    expect(columns).toContain('heartbeat_at');
    expect(columns).toContain('superseded_by');

    const result = await definePipeline({
      name: 'migrated',
      run: (ctx) => ctx.step('work', () => 'value'),
    }).run({ input: undefined, storage });

    expect(result.status).toBe('completed');
    expect(storage.readRun(result.id)!.steps[0]!.output).toBe('value');
    db.close();
  });
});
