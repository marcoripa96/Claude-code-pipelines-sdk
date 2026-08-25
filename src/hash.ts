import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

/** Directories never walked when resolving cache input patterns. */
const DEFAULT_IGNORE = new Set(['node_modules', '.git', '.pipeline', 'dist', 'build', '.next', '.turbo', 'coverage']);

export function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

/**
 * JSON stringify with deterministically ordered object keys, so that two
 * structurally equal values always produce the same string (and thus the same
 * cache key) regardless of construction order.
 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(normalize(value)) ?? 'undefined';
}

function normalize(value: unknown): unknown {
  if (value === null || typeof value !== 'object') {
    return typeof value === 'function' ? `[fn ${(value as Function).name || 'anonymous'}]` : value;
  }
  if (Array.isArray(value)) return value.map(normalize);
  if (value instanceof Date) return value.toISOString();
  if (value instanceof RegExp) return value.toString();
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    const v = (value as Record<string, unknown>)[key];
    if (v === undefined) continue;
    out[key] = normalize(v);
  }
  return out;
}

/** Convert a glob pattern into an anchored regex. Supports `**`, `*`, `?` and `{a,b}`. */
export function globToRegExp(pattern: string): RegExp {
  let re = '';
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i]!;
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        // `**/` matches zero or more path segments; a bare `**` matches anything.
        if (pattern[i + 2] === '/') {
          re += '(?:[^/]+/)*';
          i += 3;
          continue;
        }
        re += '.*';
        i += 2;
        continue;
      }
      re += '[^/]*';
      i += 1;
      continue;
    }
    if (c === '?') {
      re += '[^/]';
      i += 1;
      continue;
    }
    if (c === '{') {
      const end = pattern.indexOf('}', i);
      if (end !== -1) {
        const alts = pattern.slice(i + 1, end).split(',');
        re += `(?:${alts.map(escapeRe).join('|')})`;
        i = end + 1;
        continue;
      }
    }
    re += escapeRe(c);
    i += 1;
  }
  return new RegExp(`^${re}$`);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Hash the files matched by `patterns` (relative to `cwd`).
 *
 * Patterns may be plain file paths, directory paths (hashed recursively) or
 * globs. The result maps each matched path to a content hash, sorted by path so
 * that the serialized form is stable.
 *
 * A pattern that matches nothing contributes `null`, which is itself part of the
 * key: a file appearing later correctly invalidates the cache entry.
 */
export async function hashInputs(cwd: string, patterns: readonly string[]): Promise<Record<string, string | null>> {
  const out: Record<string, string | null> = {};
  const globs: { pattern: string; re: RegExp }[] = [];

  for (const pattern of patterns) {
    if (/[*?{]/.test(pattern)) {
      globs.push({ pattern, re: globToRegExp(pattern) });
      continue;
    }
    const abs = join(cwd, pattern);
    const info = await stat(abs).catch(() => null);
    if (!info) {
      out[pattern] = null;
    } else if (info.isDirectory()) {
      for (const file of await walk(abs)) out[toPosix(relative(cwd, file))] = await hashFile(file);
    } else {
      out[pattern] = await hashFile(abs);
    }
  }

  if (globs.length > 0) {
    const matchedByPattern = new Map<string, number>(globs.map((g) => [g.pattern, 0]));
    for (const file of await walk(cwd)) {
      const rel = toPosix(relative(cwd, file));
      for (const g of globs) {
        if (!g.re.test(rel)) continue;
        matchedByPattern.set(g.pattern, (matchedByPattern.get(g.pattern) ?? 0) + 1);
        out[rel] ??= await hashFile(file);
      }
    }
    for (const [pattern, count] of matchedByPattern) if (count === 0) out[`${pattern} (no match)`] = null;
  }

  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : 1)));
}

async function hashFile(path: string): Promise<string> {
  return sha256(await readFile(path, 'utf8').catch(async () => (await readFile(path)).toString('base64')));
}

async function walk(dir: string, acc: string[] = []): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      // Hidden and heavy directories are never inputs; hidden *files* still are.
      if (entry.name.startsWith('.') || DEFAULT_IGNORE.has(entry.name)) continue;
      await walk(abs, acc);
    } else if (entry.isFile()) {
      acc.push(abs);
    }
  }
  return acc.sort();
}

function toPosix(p: string): string {
  return sep === '/' ? p : p.split(sep).join('/');
}
