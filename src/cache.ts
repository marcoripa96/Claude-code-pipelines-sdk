import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { NodeKind } from './types.ts';

interface CacheEntry {
  fingerprint: string;
  name: string;
  kind: NodeKind;
  createdAt: string;
  value: unknown;
}

/**
 * Content-addressed store for node results, keyed by fingerprint.
 *
 * Entries are immutable: a different fingerprint is a different file, so there
 * is never a stale entry to invalidate — only unreferenced ones to prune.
 */
export class CacheStore {
  constructor(private readonly dir: string) {}

  private path(fingerprint: string): string {
    // Shard by the first two hex chars to keep directories small.
    return join(this.dir, fingerprint.slice(0, 2), `${fingerprint}.json`);
  }

  async get(fingerprint: string): Promise<{ value: unknown } | undefined> {
    const raw = await readFile(this.path(fingerprint), 'utf8').catch(() => null);
    if (raw === null) return undefined;
    try {
      const entry = JSON.parse(raw) as CacheEntry;
      return { value: entry.value };
    } catch {
      return undefined;
    }
  }

  async set(fingerprint: string, name: string, kind: NodeKind, value: unknown): Promise<void> {
    let serialized: string;
    try {
      serialized = JSON.stringify({ fingerprint, name, kind, createdAt: new Date().toISOString(), value } satisfies CacheEntry);
    } catch {
      // A non-serializable value simply is not cacheable; the node still ran fine.
      return;
    }
    const path = this.path(fingerprint);
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    await writeFile(tmp, serialized, 'utf8');
    await rename(tmp, path);
  }

  async clear(): Promise<void> {
    await rm(this.dir, { recursive: true, force: true });
  }
}
