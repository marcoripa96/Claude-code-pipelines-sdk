import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { NodeInfo, RunSummary } from './types.ts';

export interface JournalEntry {
  fingerprint: string;
  name: string;
  status: NodeInfo['status'];
  at: string;
  durationMs: number;
  value?: unknown;
  error?: string;
}

/**
 * Append-only record of everything a run did, written as JSONL.
 *
 * The journal is what makes a failed run resumable: a later run started with
 * `resumeFrom` replays every node whose fingerprint already succeeded, and only
 * re-executes from the first node that did not.
 */
export class Journal {
  private readonly dir: string;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(rootDir: string, readonly runId: string) {
    this.dir = join(rootDir, runId);
  }

  get path(): string {
    return join(this.dir, 'journal.jsonl');
  }

  async init(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
  }

  /** Serializes appends so concurrent nodes cannot interleave partial lines. */
  append(entry: JournalEntry): Promise<void> {
    this.writeChain = this.writeChain.then(async () => {
      let line: string;
      try {
        line = JSON.stringify(entry);
      } catch {
        line = JSON.stringify({ ...entry, value: undefined });
      }
      await appendFile(this.path, `${line}\n`, 'utf8').catch(() => {});
    });
    return this.writeChain;
  }

  async writeSummary(summary: RunSummary): Promise<void> {
    await this.writeChain;
    await writeFile(join(this.dir, 'summary.json'), JSON.stringify(summary, null, 2), 'utf8').catch(() => {});
  }
}

/** Load the successful results of a previous run, keyed by fingerprint. */
export async function loadJournal(rootDir: string, runId: string): Promise<Map<string, JournalEntry>> {
  const raw = await readFile(join(rootDir, runId, 'journal.jsonl'), 'utf8').catch(() => null);
  const byFingerprint = new Map<string, JournalEntry>();
  if (raw === null) return byFingerprint;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as JournalEntry;
      if (entry.status === 'failed') byFingerprint.delete(entry.fingerprint);
      else byFingerprint.set(entry.fingerprint, entry);
    } catch {
      // A truncated final line (killed mid-write) is simply not resumable.
    }
  }
  return byFingerprint;
}
