import { sqliteStorage } from '@marcoripa96/claude-code-pipelines-sdk';
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
  const actor = required('KANBY_AGENT');
  const kanby = kanbyCli({ actor, apiKey: required('KANBY_API_KEY') });
  const sshAuthSock = process.env.SSH_AUTH_SOCK;
  delete process.env.KANBY_API_KEY;
  delete process.env.SSH_AUTH_SOCK;

  // Sessions read the board and write nothing to it. If a read-only board
  // credential is supplied it becomes the ambient one, so `kanby show` works in a
  // session while every mutation still runs through a recorded pipeline step with
  // the write credential the adapter captured above. Without it, sessions have no
  // board access at all — the prompts' `kanby show` will fail, and the run with it.
  const readApiKey = process.env.KANBY_READ_API_KEY;
  delete process.env.KANBY_READ_API_KEY;
  if (readApiKey) process.env.KANBY_API_KEY = readApiKey;
  else delete process.env.KANBY_AGENT;

  const host = required('GITLAB_HOST');
  const mergeRequests = gitLabMergeRequests({ host, token: required('GITLAB_TOKEN') });
  // Claude, checks, Git hooks and Kanby inherit this process environment. Each
  // credential has already been captured where it is needed; no session or child
  // process should receive any of them.
  delete process.env.GITLAB_TOKEN;

  // The run's own record. The board carries the task-facing evidence; this carries
  // the step-by-step history a human reads when a run goes wrong.
  const storage = sqliteStorage({ path: process.env.RUN_DB ?? '.pipelines/runs.sqlite' });

  const result = await createKanbyFactory({
    kanby,
    repository: gitRepository({ sshAuthSock }),
    mergeRequests,
    checks: sandboxedChecks({ executable: required('SANDBOX_RUNNER') }),
  }).run({
    input: {
      taskGuid,
      testCommand: process.env.TEST_COMMAND ?? 'bun test',
      maxRevisions: number('MAX_REVISIONS'),
      minConfidence: number('MIN_CONFIDENCE'),
      maxUnattendedRisk: process.env.MAX_UNATTENDED_RISK as
        | 'none' | 'low' | 'medium' | 'high' | undefined,
      maxDiffBytes: number('MAX_DIFF_BYTES'),
      gitlab: {
        host,
        project: required('GITLAB_PROJECT'),
        sourceBranch: required('SOURCE_BRANCH'),
        targetBranch: process.env.TARGET_BRANCH ?? 'main',
      },
    },
    workspace,
    storage,
    on: progressEvents,
  });
  storage.db.close();
  finish(result);
}

const progressEvents = {
  stepStarted: (step: { name: string }) => console.log('start', step.name),
  stepFinished: (step: { name: string; status: string }) =>
    console.log('finish', step.name, step.status),
};

function finish(result: { id: string; status: string; haltReason?: string; error?: string }): void {
  console.log(result.status, result.haltReason ?? result.error ?? '');
  console.log(`run ${result.id}`);
  if (result.status === 'failed') process.exitCode = 1;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

/** Absent means "use the pipeline's default", which the input schema owns. */
function number(name: string): number | undefined {
  const value = process.env[name];
  return value === undefined ? undefined : Number(value);
}
