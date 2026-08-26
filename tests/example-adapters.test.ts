import { describe, expect, test } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gitRepository } from '../examples/kanby-software-factory/adapters.ts';
import type {
  GitLabDestination,
  KanbyTask,
} from '../examples/kanby-software-factory/pipeline.ts';

describe('the kanby-software-factory Git adapter', () => {
  test('validates the destination and reuses a task commit after an ambiguous retry', async () => {
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

    await Bun.write(join(workspace, 'change.txt'), 'implemented\n');
    const staged = await repository.stage(workspace, destination.sourceBranch, signal);
    expect(staged.truncated).toBe(false);

    const task: KanbyTask = {
      guid: '019f-task',
      displayNumber: 42,
      title: 'Fix digest dates',
      description: '',
      content: '',
      status: 'in_progress',
      blocked: null,
      updatedMs: 123,
      outputKeys: [
        'prepare-kanby-task/classification',
        'prepare-kanby-task/analysis',
      ],
    };

    const first = await repository.commit(workspace, task, destination.sourceBranch, signal);
    const retried = await repository.commit(workspace, task, destination.sourceBranch, signal);

    expect(retried.sha).toBe(first.sha);
    expect((await runGit(workspace, ['log', '-1', '--format=%B'])).stdout).toContain(
      'Kanby-Task: 019f-task',
    );
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
