import { gitWorkspaceSnapshots, sqliteStorage } from '@marcoripa96/claude-code-pipelines-sdk';
import {
  PRIVILEGED_ENV,
  gitLabMergeRequests,
  gitRepository,
  kanbyCli,
  sandboxedChecks,
} from './adapters.ts';
import { RISK_LEVELS } from './contracts.ts';
import { createKanbyFactory } from './pipeline.ts';

export * from './adapters.ts';
export * from './contracts.ts';
export * from './pipeline.ts';

if (import.meta.main) await main();

async function main(): Promise<void> {
  if (!process.argv.includes('--real')) {
    throw new Error('This example changes a real task and repository. Read README.md, then pass --real.');
  }

  const workspace = required('WORKSPACE');
  const recovering = flag('--recover');

  // Taken out of the environment in one move, before anything can spawn: from here on
  // the only way to a credential is to have been handed one.
  const credentials = takeCredentials();
  const actor = credential(credentials, 'KANBY_AGENT');
  const kanby = kanbyCli({ actor, apiKey: credential(credentials, 'KANBY_API_KEY') });

  // Sessions read the board and write nothing to it. A read-only board credential, if
  // one is supplied, becomes the ambient identity, so `kanby show` works in a session
  // while every mutation still runs through a recorded pipeline step under the write
  // credential above. Without one, sessions have no board access at all — the prompts'
  // `kanby show` will fail, and the run with it.
  const readApiKey = process.env.KANBY_READ_API_KEY;
  delete process.env.KANBY_READ_API_KEY;
  if (readApiKey) {
    process.env.KANBY_API_KEY = readApiKey;
    process.env.KANBY_AGENT = actor;
  }

  // A recovered run reads its task, workspace and model back from the record it is
  // taking over, so nothing about the task is asked for on the command line.
  const taskGuid = recovering ? '' : required('KANBY_TASK_GUID');
  const host = required('GITLAB_HOST');
  const mergeRequests = gitLabMergeRequests({
    host,
    token: credential(credentials, 'GITLAB_TOKEN'),
  });

  // The run's own record. The board carries the task-facing evidence; this carries
  // the step-by-step history a human reads when a run goes wrong.
  const storage = sqliteStorage({ path: process.env.RUN_DB ?? '.pipelines/runs.sqlite' });

  const factory = createKanbyFactory({
    kanby,
    repository: gitRepository({ sshAuthSock: credentials.SSH_AUTH_SOCK }),
    mergeRequests,
    checks: sandboxedChecks({ executable: required('SANDBOX_RUNNER') }),
  });

  // The workspace is a checkout, so a replayed step's edits come back from Git rather
  // than from re-running the session that made them (ADR 0011).
  const snapshots = gitWorkspaceSnapshots();

  if (recovering) {
    const result = await factory.recover({
      runId: recovering,
      storage,
      snapshots,
      on: progressEvents,
    });
    storage.db.close();
    finish(result);
    return;
  }

  const result = await factory.run({
    input: {
      taskGuid,
      testCommand: process.env.TEST_COMMAND ?? 'bun test',
      maxRevisions: number('MAX_REVISIONS'),
      minConfidence: number('MIN_CONFIDENCE'),
      maxUnattendedRisk: choice('MAX_UNATTENDED_RISK', RISK_LEVELS),
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
    snapshots,
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

/** The value after a flag, or `undefined` when it was not passed. */
function flag(name: string): string | undefined {
  const at = process.argv.indexOf(name);
  if (at === -1) return undefined;
  const value = process.argv[at + 1];
  if (!value) throw new Error(`${name} needs the id of the run to take over`);
  return value;
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

/** As `number()`, for a variable that must name one of a fixed set if it names anything. */
function choice<T extends string>(name: string, allowed: readonly T[]): T | undefined {
  const value = process.env[name];
  if (value === undefined) return undefined;
  if (!(allowed as readonly string[]).includes(value)) {
    throw new Error(`${name} must be one of: ${allowed.join(', ')}. Got ${value}`);
  }
  return value as T;
}

/**
 * Reads every privileged variable out of this process and removes it.
 *
 * Claude sessions inherit this process's environment, so the scrub has to happen to the
 * process itself and not only per spawn — `runProcess` filters the same list again, from
 * the same declaration, so an adapter used outside this entry point is no less safe.
 */
function takeCredentials(): Partial<Record<(typeof PRIVILEGED_ENV)[number], string>> {
  const taken: Partial<Record<(typeof PRIVILEGED_ENV)[number], string>> = {};
  for (const name of PRIVILEGED_ENV) {
    const value = process.env[name];
    if (value) taken[name] = value;
    delete process.env[name];
  }
  return taken;
}

function credential(
  taken: Partial<Record<(typeof PRIVILEGED_ENV)[number], string>>,
  name: (typeof PRIVILEGED_ENV)[number],
): string {
  const value = taken[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
