import { Database } from 'bun:sqlite';
import { statSync } from 'node:fs';
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
  /** Every upstream step's recorded artifacts, in order. */
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

/**
 * Contents of every declared input file, keyed by path. A glob is expanded, a
 * directory is expanded as everything beneath it, and a path that is not there yet
 * hashes as absent — so the file appearing later changes the key.
 */
async function hashInputFiles(
  workspace: string,
  patterns: string[],
): Promise<Record<string, string>> {
  const paths = new Set<string>();
  for (const pattern of patterns) {
    for await (const path of expand(workspace, pattern)) paths.add(path);
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

async function* expand(workspace: string, pattern: string): AsyncGenerator<string> {
  if (isGlob(pattern)) {
    yield* new Bun.Glob(pattern).scan({ cwd: workspace, dot: true });
    return;
  }
  // A bare directory is what someone means by `inputs: ['src']`; hashing it as one
  // absent file would make the whole declaration a silent no-op.
  if (isDirectory(`${workspace}/${pattern}`)) {
    const inside = pattern.replace(/\/+$/, '');
    yield* new Bun.Glob(`${inside}/**`).scan({ cwd: workspace, dot: true });
    return;
  }
  yield pattern;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isGlob(pattern: string): boolean {
  return /[*?[\]{}]/.test(pattern);
}

/**
 * Key order must not change the hash, so objects are serialised with sorted keys.
 *
 * Values `JSON.stringify` would flatten are tagged instead: a `Date`, a `Map`, a `Set`
 * and a bare `{}` must not hash alike, because two different values sharing a key is
 * the stale-hit failure ADR 0006 exists to avoid.
 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(normalise(value, new Set())) ?? 'undefined';
}

function normalise(value: unknown, seen: Set<object>): unknown {
  if (typeof value === 'bigint') return tag('BigInt', `${value}`);
  if (typeof value === 'symbol') return tag('Symbol', String(value));
  if (typeof value === 'function') return tag('Function', value.name || 'anonymous');
  if (typeof value === 'number' && !Number.isFinite(value)) return tag('Number', String(value));
  if (typeof value !== 'object' || value === null) return value;

  if (seen.has(value)) {
    throw new Error(
      'Cannot compute a cache key for a value that references itself. Declare a ' +
        'cacheable step\'s inputs as plain data, or drop `cache` from the step.',
    );
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((entry) => normalise(entry, seen));
    if (value instanceof Date) return tag('Date', value.toISOString());
    if (value instanceof RegExp) return tag('RegExp', `${value.source}/${value.flags}`);
    if (value instanceof URL) return tag('URL', value.href);
    if (value instanceof Map) {
      return tag(
        'Map',
        [...value.entries()]
          .map(([k, v]) => [normalise(k, seen), normalise(v, seen)])
          .sort(compareSerialised),
      );
    }
    if (value instanceof Set) {
      return tag('Set', [...value].map((entry) => normalise(entry, seen)).sort(compareSerialised));
    }
    if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
      return tag('Bytes', new Bun.CryptoHasher('sha256').update(value as never).digest('hex'));
    }

    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => [k, normalise(v, seen)] as const);
    const plain = Object.fromEntries(entries);

    // Two class instances with the same fields are still two different values.
    const name = value.constructor?.name;
    return name && name !== 'Object' ? tag(name, plain) : plain;
  } finally {
    seen.delete(value);
  }
}

function tag(type: string, value: unknown): Record<string, unknown> {
  return { '~type': type, value };
}

function compareSerialised(a: unknown, b: unknown): number {
  const [x, y] = [JSON.stringify(a) ?? '', JSON.stringify(b) ?? ''];
  return x < y ? -1 : x > y ? 1 : 0;
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
