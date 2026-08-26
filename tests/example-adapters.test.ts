import { describe, expect, test } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gitRepository } from '../examples/kanby-software-factory/adapters.ts';
import type { GitLabDestination } from '../examples/kanby-software-factory/contracts.ts';

describe('the kanby-software-factory Git adapter', () => {
  test('validates the destination and reads back the commit a session left', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'implement-kanby-task-'));
    await runGit(workspace, ['init', '-b', 'task/42-digest-dates']);
    await runGit(workspace, ['config', 'user.name', 'Example Agent']);
    await runGit(workspace, ['config', 'user.email', 'agent@example.test']);
    await runGit(workspace, [
      'remote',
      'add',
      'origin',
      'git@gitlab.example.internal:group/project.git',
    ]);

    const repository = gitRepository();
    const destination: GitLabDestination = {
      host: 'https://gitlab.example.internal',
      project: 'group/project',
      sourceBranch: 'task/42-digest-dates',
      targetBranch: 'main',
    };
    const signal = new AbortController().signal;

    await expect(repository.preflight(workspace, destination, signal)).resolves.toBeUndefined();
    await expect(
      repository.preflight(workspace, { ...destination, project: 'other/project' }, signal),
    ).rejects.toThrow('origin fetch URL points to gitlab.example.internal/group/project');

    await runGit(workspace, [
      'remote',
      'set-url',
      '--add',
      '--push',
      'origin',
      'git@other.example.internal:group/project.git',
    ]);
    await expect(repository.preflight(workspace, destination, signal)).rejects.toThrow(
      'origin push URL points to other.example.internal/group/project',
    );
    await runGit(workspace, ['config', '--unset-all', 'remote.origin.pushurl']);

    await runGit(workspace, [
      'remote',
      'set-url',
      'origin',
      'https://gitlab.example.internal/gitlab/group/project.git',
    ]);
    await expect(
      repository.preflight(
        workspace,
        { ...destination, host: 'https://gitlab.example.internal/gitlab' },
        signal,
      ),
    ).resolves.toBeUndefined();

    // A local `main` to measure against: the adapter prefers `origin/<target>` and falls
    // back to the local branch, which is what a fresh checkout in a test has.
    await Bun.write(join(workspace, 'base.txt'), 'base\n');
    await runGit(workspace, ['add', '-A']);
    await runGit(workspace, ['commit', '-m', 'base']);
    await runGit(workspace, ['branch', 'main']);

    // Nothing committed yet, so there is nothing a review could be bound to.
    await expect(repository.verifyCommit(workspace, destination, signal)).rejects.toThrow(
      'no commit to review',
    );

    // Work left uncommitted is work the review would never see. Reviewing the subset
    // silently is the failure worth refusing.
    await Bun.write(join(workspace, 'change.txt'), 'implemented\n');
    await expect(repository.verifyCommit(workspace, destination, signal)).rejects.toThrow(
      'workspace is not clean',
    );

    await runGit(workspace, ['add', '-A']);
    await runGit(workspace, ['commit', '-m', '#42 Fix digest dates']);

    const change = await repository.verifyCommit(workspace, destination, signal);
    const head = (await runGit(workspace, ['rev-parse', 'HEAD'])).stdout.trim();
    expect(change.sha).toBe(head);
    expect(change.commits).toBe(1);
    expect(change.diffBytes).toBeGreaterThan(0);

    // Reading back what is already there is an observation, so it answers identically
    // every time — which is what makes the step safe to repeat after a crash.
    expect(await repository.verifyCommit(workspace, destination, signal)).toEqual(change);

    // A revision round commits again. The change is still measured from the merge base,
    // so the reviewer scores the whole change a human would open, not the delta from
    // the previous round.
    await Bun.write(join(workspace, 'change.txt'), 'implemented, revised\n');
    await runGit(workspace, ['add', '-A']);
    await runGit(workspace, ['commit', '-m', '#42 address review']);

    const revised = await repository.verifyCommit(workspace, destination, signal);
    expect(revised.commits).toBe(2);
    expect(revised.base).toBe(change.base);
    expect(revised.sha).not.toBe(change.sha);

    // And push refuses a sha that is not the one HEAD is at: what gets published is the
    // commit the review was bound to, or nothing.
    await expect(
      repository.push(
        workspace,
        { ...destination, host: 'https://gitlab.example.internal/gitlab' },
        change.sha,
        signal,
      ),
    ).rejects.toThrow('does not match commit step');
  });
});

async function runGit(cwd: string, args: string[]): Promise<{ stdout: string }> {
  const child = Bun.spawn(['git', ...args], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) throw new Error(stderr || `git ${args.join(' ')} exited ${exitCode}`);
  return { stdout };
}
