import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SnapshotContext, WorkspaceSnapshots } from './types.ts';

export interface GitSnapshotOptions {
  /** Namespace for the refs a run's snapshots are kept under. */
  refPrefix?: string;
  /** Name recorded as the author of a snapshot commit. */
  author?: { name: string; email: string };
}

/**
 * Workspace snapshots backed by Git plumbing (ADR 0011).
 *
 * Captures both the working tree and the index, through a scratch index file so the
 * workspace's own index is never touched, and keeps each snapshot alive behind
 * `refs/pipelines/<runId>/<step>` — inspectable with ordinary Git, and safe from
 * collection until you delete the ref.
 *
 * Files Git ignores are not captured, which is what makes this cheap; a pipeline that
 * depends on ignored state must rebuild it in a step.
 */
export function gitWorkspaceSnapshots(options: GitSnapshotOptions = {}): WorkspaceSnapshots {
  const refPrefix = options.refPrefix ?? 'refs/pipelines';
  const author = options.author ?? { name: 'claude-code-pipelines', email: 'pipelines@localhost' };
  const identity = {
    GIT_AUTHOR_NAME: author.name,
    GIT_AUTHOR_EMAIL: author.email,
    GIT_COMMITTER_NAME: author.name,
    GIT_COMMITTER_EMAIL: author.email,
  };

  return {
    async capture(context: SnapshotContext): Promise<string | undefined> {
      await assertRepositoryRoot(context.workspace, context.signal);
      // A scratch index: `git add -A` against the real one would stage the whole
      // workspace as a side effect of recording it.
      const scratch = join(tmpdir(), `pipelines-index-${crypto.randomUUID()}`);
      try {
        const scratchEnv = { GIT_INDEX_FILE: scratch };
        await git(context.workspace, ['add', '-A', '.'], context.signal, scratchEnv);
        const worktree = await git(context.workspace, ['write-tree'], context.signal, scratchEnv);
        const label = `${context.runId} ${context.step.index} ${context.step.name}`;
        const commit = await git(
          context.workspace,
          ['commit-tree', worktree, '-m', label],
          context.signal,
          identity,
        );
        // The staged state is worth keeping apart from the working tree: a pipeline
        // that stages a change and checks it before committing must resume with the
        // same thing staged, not with everything staged.
        const indexTree = await git(context.workspace, ['write-tree'], context.signal);
        const index = await git(
          context.workspace,
          ['commit-tree', indexTree, '-m', `${label} (index)`],
          context.signal,
          identity,
        );
        // Both get a ref. A bare tree object is reachable from nothing, and the first
        // `git gc` in the workspace would collect it out from under a later restore.
        const ref = `${refPrefix}/${context.runId}/${context.step.index}`;
        await git(context.workspace, ['update-ref', ref, commit], context.signal);
        await git(context.workspace, ['update-ref', `${ref}-index`, index], context.signal);
        return `${commit}:${index}`;
      } finally {
        await rm(scratch, { force: true });
      }
    },

    async restore(context: SnapshotContext & { snapshot: string }): Promise<void> {
      const [commit, index] = context.snapshot.split(':');
      if (!commit || !index) {
        throw new Error(`Not a git snapshot id: ${context.snapshot}`);
      }
      // Order matters: the reset puts back everything the snapshot had, the clean
      // removes what has appeared since, and the last read-tree restores what was
      // staged without touching the working tree it just rebuilt.
      await git(context.workspace, ['read-tree', '--reset', '-u', commit], context.signal);
      await git(context.workspace, ['clean', '-fd'], context.signal);
      await git(context.workspace, ['read-tree', index], context.signal);
    },
  };
}

/**
 * The workspace must be the repository's top level, not a directory inside it.
 *
 * `add -A .` is scoped to the directory it runs in, while `read-tree --reset -u` rewrites
 * the whole working tree — so a subdirectory workspace would capture part of the
 * repository and restore over all of it, deleting everything outside the workspace. The
 * asymmetry is unfixable without pathspec-scoping every command, and a workspace that is
 * half a repository is not what ADR 0011 describes.
 */
async function assertRepositoryRoot(workspace: string, signal: AbortSignal): Promise<void> {
  const probe = Bun.spawn(['git', 'rev-parse', '--show-prefix'], {
    cwd: workspace,
    stdout: 'pipe',
    stderr: 'ignore',
    signal,
  });
  const prefix = await new Response(probe.stdout).text();
  if ((await probe.exited) !== 0) {
    throw new Error(
      `gitWorkspaceSnapshots() needs a git repository, and ${workspace} is not one. ` +
        'Initialise it, or supply your own WorkspaceSnapshots.',
    );
  }
  if (prefix.trim()) {
    throw new Error(
      `gitWorkspaceSnapshots() needs the repository's top level, and ${workspace} is ` +
        `${prefix.trim()} inside one. Restoring would rewrite the whole repository, ` +
        'including everything outside the workspace. Use the top level as the workspace.',
    );
  }
}

async function git(
  cwd: string,
  args: string[],
  signal: AbortSignal,
  env: Record<string, string> = {},
): Promise<string> {
  const child = Bun.spawn(['git', ...args], {
    cwd,
    // Machine-wide git config must not change what a snapshot contains.
    env: { ...process.env, ...env, GIT_CONFIG_NOSYSTEM: '1' },
    stdout: 'pipe',
    stderr: 'pipe',
    signal,
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) {
    throw new Error(`git ${args.join(' ')} exited ${code}: ${stderr.trim()}`);
  }
  return stdout.trim();
}
