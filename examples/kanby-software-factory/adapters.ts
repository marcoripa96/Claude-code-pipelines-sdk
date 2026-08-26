import { Gitlab } from '@gitbeaker/rest';
import type {
  ChecksClient,
  GitLabDestination,
  KanbyClient,
  KanbyTask,
  MergeRequestRef,
  MergeRequestsClient,
  RepositoryClient,
  TaskOutputInput,
  TaskStatus,
} from './pipeline.ts';

interface ProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export function kanbyCli(options: {
  actor: string;
  apiKey: string;
  executable?: string;
}): KanbyClient {
  const executable = options.executable ?? 'kanby';

  const invoke = (
    workspace: string,
    args: string[],
    signal: AbortSignal,
    stdin?: string,
  ) => runChecked([executable, ...args], workspace, signal, stdin, {
    KANBY_AGENT: options.actor,
    KANBY_API_KEY: options.apiKey,
  });

  return {
    async get(taskGuid, workspace, signal) {
      const { stdout } = await invoke(workspace, ['show', taskGuid, '--json'], signal);
      const task = JSON.parse(stdout) as {
        guid: string;
        display_number: number | null;
        title: string;
        description: string;
        content: string;
        status: TaskStatus;
        blocked: null | { reason: string };
        updated_ms: number;
        outputs: { source: string; key: string }[];
      };
      return {
        guid: task.guid,
        displayNumber: task.display_number,
        title: task.title,
        description: task.description,
        content: task.content,
        status: task.status,
        blocked: task.blocked,
        updatedMs: task.updated_ms,
        outputKeys: task.outputs
          .filter((output) => output.source === 'claude-code')
          .map((output) => output.key),
      };
    },

    async claim(task, workspace, signal) {
      await invoke(
        workspace,
        [
          'claim',
          task.guid,
          '--as',
          options.actor,
          '--if-status',
          task.status,
          '--if-updated-ms',
          String(task.updatedMs),
          '--if-unblocked',
        ],
        signal,
      );
    },

    async release(taskGuid, workspace, signal) {
      await invoke(workspace, ['release', taskGuid], signal);
    },

    async move(taskGuid, status, workspace, signal) {
      await invoke(workspace, ['move', taskGuid, status], signal);
    },

    async update(taskGuid, changes, workspace, signal) {
      await invoke(workspace, ['update', taskGuid, '--content', '-'], signal, changes.content);
    },

    async block(taskGuid, reason, workspace, signal) {
      await invoke(workspace, ['block', taskGuid, '--reason', '-'], signal, reason);
    },

    async putOutput(taskGuid, output, workspace, signal) {
      await putOutput(invoke, taskGuid, output, workspace, signal);
    },

    async linkMergeRequest(taskGuid, mergeRequest, workspace, signal) {
      await invoke(
        workspace,
        [
          'development',
          'upsert',
          taskGuid,
          '--provider',
          mergeRequest.provider,
          '--host',
          mergeRequest.host,
          '--project',
          String(mergeRequest.project),
          '--iid',
          String(mergeRequest.iid),
          '--url',
          mergeRequest.url,
          '--source-branch',
          mergeRequest.sourceBranch,
          '--target-branch',
          mergeRequest.targetBranch,
          '--title',
          mergeRequest.title,
          '--state',
          mergeRequest.state,
        ],
        signal,
      );
    },
  };
}

export function sandboxedChecks(options: { executable: string }): ChecksClient {
  return {
    async run(workspace, command, signal) {
      return runProcess(
        [
          options.executable,
          'exec',
          '--workspace',
          workspace,
          '--network',
          'none',
          '--no-host-credentials',
          '--',
          'sh',
          '-c',
          command,
        ],
        workspace,
        signal,
      );
    },
  };
}

async function putOutput(
  invoke: (
    workspace: string,
    args: string[],
    signal: AbortSignal,
    stdin?: string,
  ) => Promise<ProcessResult>,
  taskGuid: string,
  output: TaskOutputInput,
  workspace: string,
  signal: AbortSignal,
): Promise<void> {
  await invoke(
    workspace,
    [
      'output',
      'upsert',
      taskGuid,
      '--source',
      'claude-code',
      '--key',
      output.key,
      '--title',
      output.title,
      '--body',
      '-',
    ],
    signal,
    output.body,
  );
}

export function gitRepository(options: { sshAuthSock?: string } = {}): RepositoryClient {
  return {
    async preflight(workspace, destination, signal) {
      const status = await git(workspace, ['status', '--porcelain'], signal);
      if (status.stdout.trim()) {
        throw new Error('workspace must be clean before the task run starts');
      }
      await assertGitDestination(workspace, destination, signal);
    },

    async stage(workspace, sourceBranch, maxDiffBytes, signal) {
      await assertBranch(workspace, sourceBranch, signal);
      await git(workspace, ['add', '--all'], signal);
      const diff = await git(workspace, ['diff', '--cached', '--no-ext-diff', '--'], signal);
      return { truncated: diff.stdout.length > maxDiffBytes };
    },

    async commit(workspace, task, sourceBranch, signal) {
      await assertBranch(workspace, sourceBranch, signal);
      const unstaged = await runProcess(
        ['git', '-c', 'core.hooksPath=/dev/null', 'diff', '--quiet'],
        workspace,
        signal,
      );
      if (unstaged.exitCode > 1) throw processError(['git', 'diff', '--quiet'], unstaged);
      const untracked = await git(workspace, ['ls-files', '--others', '--exclude-standard'], signal);
      if (unstaged.exitCode === 1 || untracked.stdout.trim()) {
        throw new Error('workspace changed after review evidence was collected');
      }
      const diff = await runProcess(['git', 'diff', '--cached', '--quiet'], workspace, signal);
      if (diff.exitCode > 1) throw processError(['git', 'diff', '--cached', '--quiet'], diff);

      const marker = `Kanby-Task: ${task.guid}`;
      if (diff.exitCode === 0) {
        const previous = await git(workspace, ['log', '-1', '--format=%B'], signal);
        if (!previous.stdout.includes(marker)) {
          throw new Error('implementation produced no changes to commit');
        }
      } else {
        const taskLabel = task.displayNumber === null ? task.guid : `#${task.displayNumber}`;
        await git(
          workspace,
          ['commit', '-m', `${taskLabel} ${task.title}`, '-m', marker],
          signal,
        );
      }

      return { sha: (await git(workspace, ['rev-parse', 'HEAD'], signal)).stdout.trim() };
    },

    async push(workspace, destination, sha, signal) {
      await assertGitDestination(workspace, destination, signal);
      const status = await git(workspace, ['status', '--porcelain'], signal);
      if (status.stdout.trim()) throw new Error('workspace must be clean before push');
      const head = (await git(workspace, ['rev-parse', 'HEAD'], signal)).stdout.trim();
      if (head !== sha) throw new Error(`HEAD ${head} does not match commit step ${sha}`);
      await git(
        workspace,
        ['push', '--set-upstream', 'origin', `${sha}:refs/heads/${destination.sourceBranch}`],
        signal,
        options.sshAuthSock ? { SSH_AUTH_SOCK: options.sshAuthSock } : undefined,
      );
    },
  };
}

export function gitLabMergeRequests(options: { host: string; token: string }): MergeRequestsClient {
  const host = normalizeHost(options.host);
  const api = new Gitlab({ host, token: options.token });

  return {
    async preflight(destination, signal) {
      assertGitLabHost(host, destination.host);
      signal.throwIfAborted();
      await Promise.all([
        api.Projects.show(destination.project),
        api.Branches.show(destination.project, destination.targetBranch),
      ]);
      signal.throwIfAborted();
    },

    async ensure(request, signal) {
      assertGitLabHost(host, request.host);
      signal.throwIfAborted();

      const findExisting = async () => {
        const matches = await api.MergeRequests.all({
          projectId: request.project,
          sourceBranch: request.sourceBranch,
          targetBranch: request.targetBranch,
          state: 'opened',
          maxPages: 1,
          perPage: 100,
        });
        return matches.find((mergeRequest) => mergeRequest.source_project_id === mergeRequest.project_id);
      };

      const existing = await findExisting();
      if (existing) return mergeRequestRef(host, request.project, existing);

      try {
        const created = await api.MergeRequests.create(
          request.project,
          request.sourceBranch,
          request.targetBranch,
          request.title,
          { description: request.description },
        );
        return mergeRequestRef(host, request.project, created);
      } catch (error) {
        // Recover when another retry/process created the same MR after our lookup.
        const raced = await findExisting();
        if (raced) return mergeRequestRef(host, request.project, raced);
        throw error;
      }
    },
  };
}

function mergeRequestRef(
  host: string,
  project: string | number,
  mergeRequest: {
    iid: number;
    web_url: string;
    title: string;
    source_branch: string;
    target_branch: string;
    state: string;
    project_id?: number;
    source_project_id?: number;
  },
): MergeRequestRef {
  return {
    provider: 'gitlab',
    host,
    project,
    iid: mergeRequest.iid,
    url: mergeRequest.web_url,
    title: mergeRequest.title,
    sourceBranch: mergeRequest.source_branch,
    targetBranch: mergeRequest.target_branch,
    state: mergeRequestState(mergeRequest.state),
  };
}

function mergeRequestState(state: string): MergeRequestRef['state'] {
  if (state === 'opened' || state === 'closed' || state === 'merged' || state === 'locked') {
    return state;
  }
  throw new Error(`Unsupported GitLab merge request state: ${state}`);
}

function normalizeHost(host: string): string {
  return host.replace(/\/+$/, '');
}

function assertGitLabHost(configured: string, requested: string): void {
  if (normalizeHost(requested) !== configured) {
    throw new Error(`GitLab host ${requested} does not match configured host ${configured}`);
  }
}

async function assertGitDestination(
  workspace: string,
  destination: GitLabDestination,
  signal: AbortSignal,
): Promise<void> {
  await assertBranch(workspace, destination.sourceBranch, signal);
  if (destination.sourceBranch === destination.targetBranch) {
    throw new Error('source branch must differ from the target branch');
  }

  const hostUrl = new URL(destination.host);
  const expected = {
    host: hostUrl.host,
    project: normalizeProject(`${hostUrl.pathname}/${destination.project}`),
  };

  for (const kind of ['fetch', 'push'] as const) {
    const args = kind === 'push'
      ? ['remote', 'get-url', '--push', '--all', 'origin']
      : ['remote', 'get-url', '--all', 'origin'];
    const urls = (await git(workspace, args, signal)).stdout.trim().split('\n').filter(Boolean);
    for (const remote of urls) {
      const actual = remoteIdentity(remote);
      if (actual.host !== expected.host || actual.project !== expected.project) {
        throw new Error(
          `origin ${kind} URL points to ${actual.host}/${actual.project}, ` +
          `expected ${expected.host}/${expected.project}`,
        );
      }
    }
  }
}

async function assertBranch(
  workspace: string,
  expected: string,
  signal: AbortSignal,
): Promise<void> {
  const branch = (await git(workspace, ['branch', '--show-current'], signal)).stdout.trim();
  if (!branch) throw new Error('workspace is on a detached HEAD');
  if (branch !== expected) {
    throw new Error(`workspace is on branch ${branch}, expected ${expected}`);
  }
}

function remoteIdentity(remote: string): { host: string; project: string } {
  if (remote.includes('://')) {
    const url = new URL(remote);
    return { host: url.host, project: normalizeProject(url.pathname) };
  }

  const scp = /^(?:[^@]+@)?([^:]+):(.+)$/.exec(remote);
  if (!scp) throw new Error('origin is not a supported GitLab remote URL');
  return { host: scp[1]!, project: normalizeProject(scp[2]!) };
}

function normalizeProject(project: string): string {
  return project.replace(/^\/+|\/+$/g, '').replace(/\.git$/, '');
}

function git(
  workspace: string,
  args: string[],
  signal: AbortSignal,
  env?: Record<string, string>,
): Promise<ProcessResult> {
  return runChecked(['git', '-c', 'core.hooksPath=/dev/null', ...args], workspace, signal, undefined, env);
}

async function runChecked(
  command: string[],
  cwd: string,
  signal: AbortSignal,
  stdin?: string,
  env?: Record<string, string>,
): Promise<ProcessResult> {
  const result = await runProcess(command, cwd, signal, stdin, env);
  if (result.exitCode !== 0) throw processError(command, result);
  return result;
}

async function runProcess(
  command: string[],
  cwd: string,
  signal: AbortSignal,
  stdin?: string,
  env?: Record<string, string>,
): Promise<ProcessResult> {
  const childEnv = { ...process.env };
  delete childEnv.GITLAB_TOKEN;
  delete childEnv.KANBY_API_KEY;
  delete childEnv.KANBY_AGENT;
  delete childEnv.SSH_AUTH_SOCK;
  if (env) Object.assign(childEnv, env);
  const child = Bun.spawn(command, {
    cwd,
    env: childEnv,
    stdin: stdin === undefined ? 'ignore' : 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    signal,
    killSignal: 'SIGKILL',
  });
  if (stdin !== undefined) {
    const sink = child.stdin;
    if (!sink) throw new Error(`Could not open stdin for ${command[0]}`);
    sink.write(stdin);
    sink.end();
  }
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, exitCode };
}

function processError(command: string[], result: ProcessResult): Error {
  const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.exitCode}`;
  return new Error(`${command.join(' ')} failed: ${detail}`);
}
