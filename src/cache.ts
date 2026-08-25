import { Database } from 'bun:sqlite';
import type { CacheAdapter } from './types.ts';

/** Everything a cacheable step's key covers. See ADR 0006 — this deliberately over-invalidates. */
export interface CacheKeyParts {
  pipeline: string;
  stepName: string;
  kind: string;
  /** The step's own configuration, with any Output schema already reduced to JSON Schema. */
  config: unknown;
  /** File patterns the step declared, relative to the workspace. */
  inputs: string[];
  workspace: string;
  /** The pipeline's input values. */
  pipelineInput: unknown;
  /** Every upstream step's Output, in order. */
  upstream: { name: string; output: unknown }[];
  /** The resolved model name, so switching models re-runs rather than reusing. */
  model: string;
}

/**
 * Hashes the six things a cacheable step could depend on. Over-invalidating costs
 * one re-run; a silently stale hit costs an afternoon.
 */
export async function computeCacheKey(parts: CacheKeyParts): Promise<string> {
  const files = await hashInputFiles(parts.workspace, parts.inputs);
  const hasher = new Bun.CryptoHasher('sha256');
  hasher.update(
    stableStringify({
      pipeline: parts.pipeline,
      stepName: parts.stepName,
      kind: parts.kind,
      config: parts.config,
      files,
      pipelineInput: parts.pipelineInput,
      upstream: parts.upstream,
      model: parts.model,
    }),
  );
  return hasher.digest('hex');
}

/** Contents of every declared input file, keyed by path. A missing file hashes as absent. */
async function hashInputFiles(
  workspace: string,
  patterns: string[],
): Promise<Record<string, string>> {
  const paths = new Set<string>();
  for (const pattern of patterns) {
    if (isGlob(pattern)) {
      for await (const match of new Bun.Glob(pattern).scan({ cwd: workspace, dot: true })) {
        paths.add(match);
      }
    } else {
      paths.add(pattern);
    }
  }

  const hashes: Record<string, string> = {};
  for (const path of [...paths].sort()) {
    const file = Bun.file(`${workspace}/${path}`);
    hashes[path] = (await file.exists())
      ? new Bun.CryptoHasher('sha256').update(await file.arrayBuffer()).digest('hex')
      : 'absent';
  }
  return hashes;
}

function isGlob(pattern: string): boolean {
  return /[*?[\]{}]/.test(pattern);
}

/** Key order must not change the hash, so objects are serialised with sorted keys. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(normalise(value));
}

function normalise(value: unknown): unknown {
  if (value === null || typeof value !== 'object') {
    return typeof value === 'bigint' ? `${value}n` : value;
  }
  if (Array.isArray(value)) return value.map(normalise);
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return Object.fromEntries(entries.map(([k, v]) => [k, normalise(v)]));
}

/** An in-process cache. Useful in tests and for a single long-lived process. */
export function memoryCache(initial?: Map<string, unknown>): CacheAdapter & { store: Map<string, unknown> } {
  const store = initial ?? new Map<string, unknown>();
  return {
    store,
    get: (key) => store.get(key),
    set: (key, value) => {
      store.set(key, value);
    },
  };
}

/** A cache that survives the process, in its own bun:sqlite file. */
export function sqliteCache(path = '.pipelines/cache.sqlite'): CacheAdapter & { db: Database } {
  if (path !== ':memory:') {
    const dir = path.slice(0, Math.max(0, path.lastIndexOf('/')));
    if (dir) require('node:fs').mkdirSync(dir, { recursive: true });
  }
  const db = new Database(path, { create: true });
  db.run(
    'CREATE TABLE IF NOT EXISTS cache (key TEXT PRIMARY KEY, value TEXT NOT NULL, created_at INTEGER NOT NULL)',
  );
  const read = db.query('SELECT value FROM cache WHERE key = ?');
  const write = db.query(
    'INSERT INTO cache (key, value, created_at) VALUES ($key, $value, $created_at) ON CONFLICT(key) DO UPDATE SET value = excluded.value, created_at = excluded.created_at',
  );

  return {
    db,
    get(key) {
      const row = read.get(key) as { value: string } | null;
      return row ? (JSON.parse(row.value) as unknown) : undefined;
    },
    set(key, value) {
      write.run({ $key: key, $value: JSON.stringify(value), $created_at: Date.now() });
    },
  };
}
