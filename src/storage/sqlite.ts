import { Database } from 'bun:sqlite';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type {
  ResumableQuery,
  RunRecord,
  RunResult,
  RunStore,
  StepKind,
  StepRecord,
  StepStatus,
  RunStatus,
} from '../types.ts';

export interface SqliteStorageOptions {
  /** Database file, or `':memory:'`. Defaults to `.pipelines/runs.sqlite`. */
  path?: string;
  /** An already-open database to write into, instead of opening one. */
  database?: Database;
}

export interface SqliteStorage extends RunStore {
  /**
   * The underlying database. Reads are yours to write, in your own SQL, and so is
   * closing it — an adapter outlives the runs written through it.
   */
  readonly db: Database;
  // Narrowed to their synchronous forms: `bun:sqlite` does not await, and a caller
  // reading a run back should not have to pretend otherwise.
  readRun(runId: string): RunResult | undefined;
  resumable(query?: ResumableQuery): RunRecord[];
  heartbeat(runId: string, at: number): void;
  /** True when this process won the takeover; false when another got there first. */
  runSuperseded(previous: string, by: string): boolean;
}

/**
 * Adds a column unless it is already there. Table and column names come from this
 * file, never from a caller, so interpolating them is not a data path.
 */
function addColumn(db: Database, table: string, column: string, type: string): void {
  const columns = db.query(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (columns.some((existing) => existing.name === column)) return;
  db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  pipeline TEXT NOT NULL,
  status TEXT NOT NULL,
  workspace TEXT NOT NULL,
  input TEXT,
  model TEXT,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  duration_ms INTEGER,
  output TEXT,
  halt_reason TEXT,
  error TEXT,
  -- A run's lease. Renewed while it lives; gone quiet means its owner is gone and
  -- another process may finish its work (ADR 0009).
  heartbeat_at INTEGER,
  -- The run that took this one over, when a crash left it behind.
  superseded_by TEXT
);
CREATE TABLE IF NOT EXISTS steps (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  idx INTEGER NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  duration_ms INTEGER,
  output TEXT,
  text TEXT,
  error TEXT,
  exit_code INTEGER,
  session_id TEXT,
  attempts INTEGER,
  cache_key TEXT,
  cache_hit INTEGER,
  -- Persisted so a consumer can rebuild a RunResult and pass it back as resumeFrom:
  -- without the fingerprint there is nothing to match a replayable step on.
  fingerprint TEXT,
  replayed INTEGER,
  -- How a step resolved against a step a crash left in flight (ADR 0009).
  recovered TEXT,
  -- Workspace snapshot taken after this step completed (ADR 0011).
  snapshot TEXT
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  step_id TEXT NOT NULL REFERENCES steps(id),
  seq INTEGER NOT NULL,
  type TEXT,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS steps_run_id ON steps(run_id);
CREATE INDEX IF NOT EXISTS messages_step_id ON messages(step_id);
`;

/**
 * The default storage adapter: one table for runs, one for steps, one for messages.
 *
 * Write-only and append-or-update; it never deletes anything. Retention is yours,
 * and so are reads — this is a store you can point your own SQL at (ADR 0003).
 *
 * One adapter serves any number of runs. It does not close the database, because it
 * does not know when you are finished with it; call `storage.db.close()` yourself.
 */
export function sqliteStorage(options: SqliteStorageOptions | string = {}): SqliteStorage {
  const config = typeof options === 'string' ? { path: options } : options;
  const db = config.database ?? openDatabase(config.path ?? '.pipelines/runs.sqlite');
  db.run(SCHEMA);
  // CREATE TABLE IF NOT EXISTS leaves an existing table exactly as it found it, so a
  // column added after a database was first created has to be added explicitly. An
  // adapter is routinely pointed at the consumer's own long-lived database.
  addColumn(db, 'steps', 'fingerprint', 'TEXT');
  addColumn(db, 'steps', 'replayed', 'INTEGER');
  addColumn(db, 'steps', 'recovered', 'TEXT');
  addColumn(db, 'steps', 'snapshot', 'TEXT');
  addColumn(db, 'runs', 'heartbeat_at', 'INTEGER');
  addColumn(db, 'runs', 'superseded_by', 'TEXT');

  // A plain insert: a run id that is already recorded is a mistake worth hearing about,
  // not two runs to be merged into one row with interleaved steps.
  const insertRun = db.query(`
    INSERT INTO runs (id, pipeline, status, workspace, input, model, started_at, heartbeat_at)
    VALUES ($id, $pipeline, $status, $workspace, $input, $model, $started_at, $started_at)
  `);
  const updateRun = db.query(`
    UPDATE runs SET status = $status, finished_at = $finished_at, duration_ms = $duration_ms,
      output = $output, halt_reason = $halt_reason, error = $error
    WHERE id = $id
  `);
  // The fingerprint is written here, not only on completion: a step interrupted by a
  // crash has to be identifiable from the row that says it started (ADR 0009).
  const insertStep = db.query(`
    INSERT INTO steps (id, run_id, idx, name, kind, status, started_at, fingerprint)
    VALUES ($id, $run_id, $idx, $name, $kind, $status, $started_at, $fingerprint)
  `);
  const updateStep = db.query(`
    UPDATE steps SET status = $status, finished_at = $finished_at, duration_ms = $duration_ms,
      output = $output, text = $text, error = $error, exit_code = $exit_code,
      session_id = $session_id, attempts = $attempts, cache_key = $cache_key, cache_hit = $cache_hit,
      fingerprint = $fingerprint, replayed = $replayed, recovered = $recovered,
      snapshot = $snapshot
    WHERE id = $id
  `);
  const beat = db.query('UPDATE runs SET heartbeat_at = $at WHERE id = $id');
  const supersede = db.query(
    "UPDATE runs SET status = 'superseded', superseded_by = $by WHERE id = $id AND status = 'running'",
  );
  const readRunRow = db.query('SELECT * FROM runs WHERE id = $id');
  // Skipped steps carry index -1 and belong at the end, where the halt put them.
  const readStepRows = db.query(
    'SELECT * FROM steps WHERE run_id = $id ORDER BY (idx < 0), idx, started_at',
  );
  const insertMessage = db.query(`
    INSERT INTO messages (step_id, seq, type, body, created_at)
    VALUES ($step_id, $seq, $type, $body, $created_at)
  `);

  const seqByStep = new Map<string, number>();

  return {
    db,
    runStarted(run: RunRecord) {
      try {
        insertRun.run({
          $id: run.id,
          $pipeline: run.pipeline,
          $status: run.status,
          $workspace: run.workspace,
          $input: json(run.input),
          $model: run.model ?? null,
          $started_at: run.startedAt,
        });
      } catch (error) {
        throw new Error(
          `A run with id ${run.id} is already recorded; a run id must be unique.`,
          { cause: error },
        );
      }
    },
    runFinished(run: RunRecord) {
      updateRun.run({
        $id: run.id,
        $status: run.status,
        $finished_at: run.finishedAt ?? null,
        $duration_ms: run.durationMs ?? null,
        $output: json(run.output),
        $halt_reason: run.haltReason ?? null,
        $error: run.error ?? null,
      });
    },
    stepStarted(step: StepRecord) {
      insertStep.run({
        $id: step.id,
        $run_id: step.runId,
        $idx: step.index,
        $name: step.name,
        $kind: step.kind,
        $status: step.status,
        $started_at: step.startedAt,
        $fingerprint: step.fingerprint ?? null,
      });
    },
    stepFinished(step: StepRecord) {
      updateStep.run({
        $id: step.id,
        $status: step.status,
        $finished_at: step.finishedAt ?? null,
        $duration_ms: step.durationMs ?? null,
        $output: json(step.output),
        $text: step.text ?? null,
        $error: step.error ?? null,
        $exit_code: step.exitCode ?? null,
        $session_id: step.sessionId ?? null,
        $attempts: step.attempts ?? null,
        $cache_key: step.cacheKey ?? null,
        $cache_hit: step.cacheHit === undefined ? null : step.cacheHit ? 1 : 0,
        $fingerprint: step.fingerprint ?? null,
        $replayed: step.replayed === undefined ? null : step.replayed ? 1 : 0,
        $recovered: step.recovered ?? null,
        $snapshot: step.snapshot ?? null,
      });
    },
    messageAppended(stepId: string, message: SDKMessage) {
      const seq = (seqByStep.get(stepId) ?? 0) + 1;
      seqByStep.set(stepId, seq);
      insertMessage.run({
        $step_id: stepId,
        $seq: seq,
        $type: (message as { type?: string }).type ?? null,
        $body: json(message) ?? 'null',
        $created_at: Date.now(),
      });
    },
    heartbeat(runId: string, at: number) {
      beat.run({ $id: runId, $at: at });
    },
    runSuperseded(previous: string, by: string): boolean {
      // The UPDATE is conditional on the run still being `running`, so the row count is
      // the arbitration: exactly one of two racing supervisors changes it.
      return supersede.run({ $id: previous, $by: by }).changes > 0;
    },
    readRun(runId: string): RunResult | undefined {
      const row = readRunRow.get({ $id: runId }) as RunRow | null;
      if (!row) return undefined;
      return {
        ...runRecord(row),
        steps: (readStepRows.all({ $id: runId }) as StepRow[]).map(stepRecord),
      };
    },
    resumable(query: ResumableQuery = {}): RunRecord[] {
      const staleMs = query.staleMs ?? 60_000;
      const rows = db
        .query(
          `SELECT * FROM runs
           WHERE status = 'running'
             AND ($pipeline IS NULL OR pipeline = $pipeline)
             -- A run whose adapter never wrote a heartbeat falls back to when it
             -- started, so an abandoned run is still found rather than hidden.
             AND COALESCE(heartbeat_at, started_at) <= $before
           ORDER BY COALESCE(heartbeat_at, started_at)
           LIMIT $limit`,
        )
        .all({
          $pipeline: query.pipeline ?? null,
          $before: Date.now() - staleMs,
          $limit: query.limit ?? 100,
        }) as RunRow[];
      return rows.map(runRecord);
    },
  };
}

interface RunRow {
  id: string;
  pipeline: string;
  status: string;
  workspace: string;
  input: string | null;
  model: string | null;
  started_at: number;
  finished_at: number | null;
  duration_ms: number | null;
  output: string | null;
  halt_reason: string | null;
  error: string | null;
}

interface StepRow {
  id: string;
  run_id: string;
  idx: number;
  name: string;
  kind: string;
  status: string;
  started_at: number;
  finished_at: number | null;
  duration_ms: number | null;
  output: string | null;
  text: string | null;
  error: string | null;
  exit_code: number | null;
  session_id: string | null;
  attempts: number | null;
  cache_key: string | null;
  cache_hit: number | null;
  fingerprint: string | null;
  replayed: number | null;
  recovered: string | null;
  snapshot: string | null;
}

/** Only fields the row actually holds: an absent column stays absent, not `null`. */
function runRecord(row: RunRow): RunRecord {
  return {
    id: row.id,
    pipeline: row.pipeline,
    status: row.status as RunStatus,
    workspace: row.workspace,
    input: parse(row.input),
    startedAt: row.started_at,
    // Kept out of `defined`, which strips nulls: a run whose output really was `null`
    // must read back as `null`, not as a key that was never set. Same as `stepRecord`.
    ...(row.output === null ? {} : { output: parse(row.output) }),
    ...defined({
      model: row.model,
      finishedAt: row.finished_at,
      durationMs: row.duration_ms,
      haltReason: row.halt_reason,
      error: row.error,
    }),
  };
}

function stepRecord(row: StepRow): StepRecord {
  return {
    id: row.id,
    runId: row.run_id,
    index: row.idx,
    name: row.name,
    kind: row.kind as StepKind,
    status: row.status as StepStatus,
    startedAt: row.started_at,
    // As above: a step that returned `null` replays as `null`.
    ...(row.output === null ? {} : { output: parse(row.output) }),
    ...defined({
      finishedAt: row.finished_at,
      durationMs: row.duration_ms,
      text: row.text,
      error: row.error,
      exitCode: row.exit_code,
      sessionId: row.session_id,
      attempts: row.attempts,
      cacheKey: row.cache_key,
      cacheHit: row.cache_hit === null ? null : row.cache_hit === 1,
      fingerprint: row.fingerprint,
      replayed: row.replayed === null ? null : row.replayed === 1,
      recovered: row.recovered,
      snapshot: row.snapshot,
    }),
  } as StepRecord;
}

/** Drops the keys SQLite handed back as NULL, which in a record means "not set". */
function defined<T extends Record<string, unknown>>(fields: T): { [K in keyof T]?: NonNullable<T[K]> } {
  return Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== null && value !== undefined),
  ) as { [K in keyof T]?: NonNullable<T[K]> };
}

function parse(value: string | null): unknown {
  return value === null ? undefined : JSON.parse(value);
}

function openDatabase(path: string): Database {
  if (path !== ':memory:') {
    const dir = path.slice(0, Math.max(0, path.lastIndexOf('/')));
    if (dir) require('node:fs').mkdirSync(dir, { recursive: true });
  }
  return new Database(path, { create: true });
}

function json(value: unknown): string | null {
  if (value === undefined) return null;
  try {
    return JSON.stringify(value) ?? null;
  } catch {
    return JSON.stringify({ unserializable: String(value) });
  }
}
