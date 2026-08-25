import { Database } from 'bun:sqlite';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { RunRecord, StepRecord, StorageAdapter } from '../types.ts';

export interface SqliteStorageOptions {
  /** Database file, or `':memory:'`. Defaults to `.pipelines/runs.sqlite`. */
  path?: string;
  /** An already-open database to write into, instead of opening one. */
  database?: Database;
}

export interface SqliteStorage extends StorageAdapter {
  /**
   * The underlying database. Reads are yours to write, in your own SQL, and so is
   * closing it — an adapter outlives the runs written through it.
   */
  readonly db: Database;
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
  error TEXT
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
  replayed INTEGER
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

  // A plain insert: a run id that is already recorded is a mistake worth hearing about,
  // not two runs to be merged into one row with interleaved steps.
  const insertRun = db.query(`
    INSERT INTO runs (id, pipeline, status, workspace, input, model, started_at)
    VALUES ($id, $pipeline, $status, $workspace, $input, $model, $started_at)
  `);
  const updateRun = db.query(`
    UPDATE runs SET status = $status, finished_at = $finished_at, duration_ms = $duration_ms,
      output = $output, halt_reason = $halt_reason, error = $error
    WHERE id = $id
  `);
  const insertStep = db.query(`
    INSERT INTO steps (id, run_id, idx, name, kind, status, started_at)
    VALUES ($id, $run_id, $idx, $name, $kind, $status, $started_at)
  `);
  const updateStep = db.query(`
    UPDATE steps SET status = $status, finished_at = $finished_at, duration_ms = $duration_ms,
      output = $output, text = $text, error = $error, exit_code = $exit_code,
      session_id = $session_id, attempts = $attempts, cache_key = $cache_key, cache_hit = $cache_hit,
      fingerprint = $fingerprint, replayed = $replayed
    WHERE id = $id
  `);
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
  };
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
