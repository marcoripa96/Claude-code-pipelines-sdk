import {
  gitLabMergeRequests,
  gitRepository,
  kanbyCli,
  sandboxedChecks,
} from './adapters.ts';
import { createKanbyFactory } from './pipeline.ts';

export * from './adapters.ts';
export * from './pipeline.ts';

if (import.meta.main) await main();

async function main(): Promise<void> {
  if (!process.argv.includes('--real')) {
    throw new Error('This example changes a real task and repository. Read README.md, then pass --real.');
  }

  const workspace = required('WORKSPACE');
  const taskGuid = required('KANBY_TASK_GUID');
  const kanby = kanbyCli({
    actor: required('KANBY_AGENT'),
    apiKey: required('KANBY_API_KEY'),
  });
  const sshAuthSock = process.env.SSH_AUTH_SOCK;
  delete process.env.KANBY_AGENT;
  delete process.env.KANBY_API_KEY;
  delete process.env.SSH_AUTH_SOCK;

  const host = required('GITLAB_HOST');
  const mergeRequests = gitLabMergeRequests({ host, token: required('GITLAB_TOKEN') });
  // Claude, checks, Git hooks and Kanby inherit this process environment. Each
  // credential has already been captured where it is needed; no session or child
  // process should receive any of them.
  delete process.env.GITLAB_TOKEN;

  const result = await createKanbyFactory({
    kanby,
    repository: gitRepository({ sshAuthSock }),
    mergeRequests,
    checks: sandboxedChecks({ executable: required('SANDBOX_RUNNER') }),
  }).run({
    input: {
      taskGuid,
      testCommand: process.env.TEST_COMMAND ?? 'bun test',
      maxRevisions: process.env.MAX_REVISIONS ? Number(process.env.MAX_REVISIONS) : 1,
      gitlab: {
        host,
        project: required('GITLAB_PROJECT'),
        sourceBranch: required('SOURCE_BRANCH'),
        targetBranch: process.env.TARGET_BRANCH ?? 'main',
      },
    },
    workspace,
    on: progressEvents,
  });
  finish(result);
}

const progressEvents = {
  stepStarted: (step: { name: string }) => console.log('start', step.name),
  stepFinished: (step: { name: string; status: string }) =>
    console.log('finish', step.name, step.status),
};

function finish(result: { status: string; haltReason?: string; error?: string }): void {
  console.log(result.status, result.haltReason ?? result.error ?? '');
  if (result.status === 'failed') process.exitCode = 1;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
