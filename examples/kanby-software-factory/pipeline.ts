import {
  definePipeline,
  type ClaudeHandle,
} from '@marcoripa96/claude-code-pipelines-sdk';
import { z } from 'zod';

export type TaskStatus = 'backlog' | 'todo' | 'in_progress' | 'in_review' | 'done';

export interface KanbyTask {
  guid: string;
  displayNumber: number | null;
  title: string;
  description: string;
  content: string;
  status: TaskStatus;
  blocked: { reason: string } | null;
  updatedMs: number;
  outputKeys: string[];
}

export interface TaskOutputInput {
  key: string;
  title: string;
  body: string;
}

export interface MergeRequestRef {
  provider: 'gitlab';
  host: string;
  project: string | number;
  iid: number;
  url: string;
  title: string;
  sourceBranch: string;
  targetBranch: string;
  state: 'opened' | 'closed' | 'merged' | 'locked';
}

export interface GitLabDestination {
  host: string;
  project: string;
  sourceBranch: string;
  targetBranch: string;
}

export interface KanbyClient {
  get(taskGuid: string, workspace: string, signal: AbortSignal): Promise<KanbyTask>;
  claim(task: KanbyTask, workspace: string, signal: AbortSignal): Promise<void>;
  release(taskGuid: string, workspace: string, signal: AbortSignal): Promise<void>;
  move(
    taskGuid: string,
    status: Extract<TaskStatus, 'todo' | 'in_progress' | 'in_review'>,
    workspace: string,
    signal: AbortSignal,
  ): Promise<void>;
  update(
    taskGuid: string,
    changes: { content: string },
    workspace: string,
    signal: AbortSignal,
  ): Promise<void>;
  block(taskGuid: string, reason: string, workspace: string, signal: AbortSignal): Promise<void>;
  putOutput(
    taskGuid: string,
    output: TaskOutputInput,
    workspace: string,
    signal: AbortSignal,
  ): Promise<void>;
  linkMergeRequest(
    taskGuid: string,
    mergeRequest: MergeRequestRef,
    workspace: string,
    signal: AbortSignal,
  ): Promise<void>;
}

export interface RepositoryClient {
  preflight(
    workspace: string,
    destination: GitLabDestination,
    signal: AbortSignal,
  ): Promise<void>;
  stage(
    workspace: string,
    sourceBranch: string,
    signal: AbortSignal,
  ): Promise<{ truncated: boolean }>;
  commit(
    workspace: string,
    task: KanbyTask,
    sourceBranch: string,
    signal: AbortSignal,
  ): Promise<{ sha: string }>;
  push(
    workspace: string,
    destination: GitLabDestination,
    sha: string,
    signal: AbortSignal,
  ): Promise<void>;
}

export interface ChecksClient {
  run(
    workspace: string,
    command: string,
    signal: AbortSignal,
  ): Promise<{ stdout: string; stderr: string; exitCode: number }>;
}

export interface MergeRequestsClient {
  preflight(
    destination: Pick<GitLabDestination, 'host' | 'project' | 'targetBranch'>,
    signal: AbortSignal,
  ): Promise<void>;
  ensure(
    request: {
      host: string;
      project: string | number;
      sourceBranch: string;
      targetBranch: string;
      title: string;
      description: string;
    },
    signal: AbortSignal,
  ): Promise<MergeRequestRef>;
}

export interface KanbyFactoryDependencies {
  kanby: KanbyClient;
  repository: RepositoryClient;
  mergeRequests: MergeRequestsClient;
  checks: ChecksClient;
}

const input = z.object({
  taskGuid: z.string().min(1),
  testCommand: z.string().min(1).default('bun test'),
  maxRevisions: z.number().int().min(0).max(5).default(1),
  gitlab: z.object({
    host: z.string().url(),
    project: z.string().min(1),
    sourceBranch: z.string().min(1),
    targetBranch: z.string().min(1).default('main'),
  }),
});

/**
 * One pipeline for every open task: it reads where the task is on the board and
 * runs exactly the stages that stage still needs. A `backlog` task goes through
 * intake (classify -> analyze -> brief -> todo) and straight on into delivery; a
 * `todo` task skips intake and starts at implementation. Stages a run did not
 * need are recorded as skipped, so the run record reads as the task's progress
 * through the factory.
 *
 * Step boundaries follow one rule: a step has exactly one observable outcome —
 * a decision (a Claude Output), one transition of one system of record, or a
 * gate verdict. Formatting and branching are code between steps; every board,
 * git and GitLab write is its own step; the five handoff paths share one ritual
 * (`handoff-block` -> `handoff-release`) so "stop and leave the card free for a
 * human" is written once.
 */
export function createKanbyFactory({
  kanby,
  repository,
  mergeRequests,
  checks,
}: KanbyFactoryDependencies) {
  return definePipeline({
    name: 'kanby-software-factory',
    input,
    steps: [
      'fetch-task',
      'claim',
      'classify',
      'publish-classification',
      'analyze',
      'publish-analysis',
      'write-brief',
      'move-todo',
      'preflight',
      'move-in-progress',
      'implement',
      'publish-implementation',
      'test',
      'publish-test',
      'stage-change',
      'review',
      'publish-review',
      'commit',
      'push',
      'open-merge-request',
      'link-development',
      'move-in-review',
      'release',
      // The shared handoff ritual. Declared last because any halt path may run
      // it; revision rounds extend `implement`, `test` and `review` with a
      // `-2`, `-3`, ... suffix, which stays undeclared by design.
      'handoff-block',
      'handoff-release',
    ],

    async run(ctx) {
      const task = await ctx.step('fetch-task', (signal) =>
        kanby.get(ctx.input.taskGuid, ctx.workspace, signal),
      );
      if (task.blocked) ctx.halt(`task is blocked: ${task.blocked.reason}`);
      if (task.status !== 'backlog' && task.status !== 'todo') {
        ctx.halt(`factory requires backlog or todo, got ${task.status}`);
      }

      await ctx.step('claim', (signal) => kanby.claim(task, ctx.workspace, signal));
      const taskLabel = label(task);
      const intake = task.status === 'backlog';
      let brief = task.content.trim();

      // Every stop-and-ask-a-human path is this ritual: record why on the card,
      // then leave the card free for a human to act on. Declared once so the
      // invariant "a handoff always releases the claim" holds everywhere.
      const handOffToHuman = (reason: string): Promise<never> =>
        ctx
          .step('handoff-block', (signal) => kanby.block(task.guid, reason, ctx.workspace, signal))
          .then(() => ctx.step('handoff-release', (signal) => kanby.release(task.guid, ctx.workspace, signal)))
          .then(() => ctx.halt(reason));

      if (intake) {
        const classification = await ctx.claude({
          name: 'classify',
          prompt:
            `You are classifying kanby task ${taskLabel}.\n\n` +
            `1. Read the task: kanby show ${task.guid}\n` +
            `2. Decide its type, your confidence, and whether it needs human triage ` +
            `before any technical work.\n\n` +
            `Answer through the structured output. Read-only: change nothing on the ` +
            `board or in the workspace.`,
          output: z.object({
            type: z.enum(['bug', 'feature', 'documentation', 'chore']),
            confidence: z.number().min(0).max(1),
            rationale: z.string(),
            requiresHumanTriage: z.boolean(),
          }),
        });

        await ctx.step('publish-classification', (signal) =>
          kanby.putOutput(
            task.guid,
            {
              key: 'kanby-software-factory/classification',
              title: 'Classification',
              body: formatClassification(classification.output),
            },
            ctx.workspace,
            signal,
          ),
        );
        if (classification.output.requiresHumanTriage || classification.output.confidence < 0.8) {
          const reason = classification.output.requiresHumanTriage
            ? `Classification requires human triage: ${classification.output.rationale}`
            : `Classification confidence is ${classification.output.confidence}: ${classification.output.rationale}`;
          await handOffToHuman(reason);
        }

        const analysis = await ctx.claude({
          name: 'analyze',
          prompt:
            `You are analysing kanby task ${taskLabel} to decide whether it is ready to ` +
            `be implemented.\n\n` +
            `1. Read the task: kanby show ${task.guid}\n` +
            `2. Ground yourself in the actual repository. Run throwaway probes where ` +
            `reading is not enough, and leave the workspace exactly as you found it.\n` +
            `3. Say what you could not verify instead of inventing it; put verification ` +
            `first in the plan when something material is unconfirmed.\n` +
            `4. Produce evidence, specification, plan, compatibility and risk through ` +
            `the structured output.\n\n` +
            `Never commit, push or mutate the board.`,
          output: z.object({
            ready: z.boolean(),
            reason: z.string(),
            evidence: z.array(z.string()),
            specification: z.string(),
            plan: z.array(z.string()),
            compatibility: z.string(),
            risk: z.enum(['low', 'medium', 'high']),
            requiredChecks: z.array(z.string()),
          }),
          retry: 2,
        });
        brief = formatAnalysis(analysis.output);

        await ctx.step('publish-analysis', (signal) =>
          kanby.putOutput(
            task.guid,
            {
              key: 'kanby-software-factory/analysis',
              title: 'Analysis',
              body: brief,
            },
            ctx.workspace,
            signal,
          ),
        );
        if (!analysis.output.ready) {
          await handOffToHuman(analysis.output.reason);
        }
        await ctx.step('write-brief', (signal) =>
          kanby.update(task.guid, { content: brief }, ctx.workspace, signal),
        );
        await ctx.step('move-todo', (signal) => kanby.move(task.guid, 'todo', ctx.workspace, signal));
      } else if (
        !['kanby-software-factory/classification', 'kanby-software-factory/analysis'].every(
          (key) => task.outputKeys.includes(key),
        )
      ) {
        await ctx.step('release', (signal) => kanby.release(task.guid, ctx.workspace, signal));
        ctx.halt('todo task is missing preparation outputs');
      }

      await ctx.step('preflight', async (signal) => {
        await repository.preflight(ctx.workspace, ctx.input.gitlab, signal);
        await mergeRequests.preflight(ctx.input.gitlab, signal);
      });
      await ctx.step('move-in-progress', (signal) =>
        kanby.move(task.guid, 'in_progress', ctx.workspace, signal),
      );

      let review!: ClaudeHandle<{
        summary: string;
        completeness: 'complete' | 'partial' | 'missing';
        concerns: string[];
        sideEffectRisk: 'none' | 'low' | 'medium' | 'high';
        performanceRisk: 'none' | 'low' | 'medium' | 'high';
        compatibilityRisk: 'none' | 'low' | 'medium' | 'high';
      }>;
      for (let round = 1; ; round++) {
        const suffix = round === 1 ? '' : `-${round}`;
        const implementation = await ctx.claude({
          name: round === 1 ? 'implement' : `implement-revise${suffix}`,
          prompt: round === 1
            ? `You are implementing kanby task ${taskLabel}.\n\n` +
              `1. Read the task: kanby show ${task.guid} — its content is the prepared brief.\n` +
              `2. Implement the brief in this workspace, as written. If the brief turns out ` +
              `to be wrong, follow it as far as it holds and say so in your summary.\n` +
              `3. Do not commit, push or touch the board: the pipeline publishes and ` +
              `records those effects itself.\n\n` +
              `Summarise what you did through the structured output.`
            : `You are revising kanby task ${taskLabel} after review round ${round - 1} ` +
              `flagged concerns.\n\n` +
              `1. Read the task: kanby show ${task.guid} — its content is the prepared ` +
              `brief, and its Review output holds the concerns to address.\n` +
              `2. Revise the implementation in this workspace.\n` +
              `3. Do not commit, push or touch the board: the pipeline publishes and ` +
              `records those effects itself.\n\n` +
              `Summarise the revision through the structured output.`,
          output: z.object({ summary: z.string() }),
        });

        await ctx.step('publish-implementation', (signal) =>
          kanby.putOutput(
            task.guid,
            {
              key: 'kanby-software-factory/implementation',
              title: 'Implementation',
              body: implementation.output.summary,
            },
            ctx.workspace,
            signal,
          ),
        );

        const tests = await ctx.step(`test${suffix}`, (signal) =>
          checks.run(ctx.workspace, ctx.input.testCommand, signal),
        );
        const checksBody = formatCommandOutput(
          ctx.input.testCommand,
          tests.exitCode,
          tests.stdout,
          tests.stderr,
        );
        await ctx.step('publish-test', (signal) =>
          kanby.putOutput(
            task.guid,
            {
              key: 'kanby-software-factory/checks',
              title: 'Checks',
              body: checksBody,
            },
            ctx.workspace,
            signal,
          ),
        );

        if (tests.exitCode !== 0) {
          await handOffToHuman(
            `Check command exited ${tests.exitCode}: ${ctx.input.testCommand}`,
          );
        }

        const staged = await ctx.step('stage-change', (signal) =>
          repository.stage(ctx.workspace, ctx.input.gitlab.sourceBranch, signal),
        );
        if (staged.truncated) {
          await handOffToHuman('Change is too large for automated review');
        }

        review = await ctx.claude({
          name: `review${suffix}`,
          prompt:
            `You are reviewing kanby task ${taskLabel} before a human reviewer does.\n\n` +
            `1. Read the task: kanby show ${task.guid} — its content is the prepared ` +
            `brief, and its Checks output holds the recorded check run.\n` +
            `2. Get the change: git diff --cached\n` +
            `3. Judge completeness against the brief and the change's side-effect, ` +
            `performance and compatibility risk.\n\n` +
            `Review, do not fix. Answer through the structured output.`,
          output: z.object({
            summary: z.string(),
            completeness: z.enum(['complete', 'partial', 'missing']),
            concerns: z.array(z.string()),
            sideEffectRisk: z.enum(['none', 'low', 'medium', 'high']),
            performanceRisk: z.enum(['none', 'low', 'medium', 'high']),
            compatibilityRisk: z.enum(['none', 'low', 'medium', 'high']),
          }),
        });

        await ctx.step('publish-review', (signal) =>
          kanby.putOutput(
            task.guid,
            {
              key: 'kanby-software-factory/review',
              title: 'Review',
              body: formatReview(review.output),
            },
            ctx.workspace,
            signal,
          ),
        );

        const concerns =
          review.output.completeness !== 'complete' || review.output.concerns.length > 0;
        if (!concerns) break;
        if (round > ctx.input.maxRevisions) {
          const reason =
            review.output.concerns.join('; ') || `Implementation is ${review.output.completeness}`;
          await handOffToHuman(reason);
        }
      }

      const commit = await ctx.step('commit', (signal) =>
        repository.commit(ctx.workspace, task, ctx.input.gitlab.sourceBranch, signal),
      );
      await ctx.step('push', (signal) =>
        repository.push(ctx.workspace, ctx.input.gitlab, commit.sha, signal),
      );

      // One system of record per step: GitLab owns the merge request, Kanby
      // owns the task's development link to it.
      const mergeRequest = await ctx.step('open-merge-request', (signal) =>
        mergeRequests.ensure(
          {
            host: ctx.input.gitlab.host,
            project: ctx.input.gitlab.project,
            sourceBranch: ctx.input.gitlab.sourceBranch,
            targetBranch: ctx.input.gitlab.targetBranch,
            title: `${taskLabel} ${task.title}`,
            description: `${review.output.summary}\n\nKanby task: ${task.guid}`,
          },
          signal,
        ),
      );
      await ctx.step('link-development', (signal) =>
        kanby.linkMergeRequest(task.guid, mergeRequest, ctx.workspace, signal),
      );
      await ctx.step('move-in-review', (signal) =>
        kanby.move(task.guid, 'in_review', ctx.workspace, signal),
      );
      await ctx.step('release', (signal) => kanby.release(task.guid, ctx.workspace, signal));
    },
  });
}

function label(task: KanbyTask): string {
  return task.displayNumber === null ? task.guid : `#${task.displayNumber}`;
}

function formatClassification(output: {
  type: string;
  confidence: number;
  rationale: string;
  requiresHumanTriage: boolean;
}): string {
  return [
    `**Type:** ${output.type}`,
    `**Confidence:** ${Math.round(output.confidence * 100)}%`,
    `**Human triage:** ${output.requiresHumanTriage ? 'required' : 'not required'}`,
    '',
    output.rationale,
  ].join('\n');
}

function formatAnalysis(output: {
  ready: boolean;
  reason: string;
  evidence: string[];
  specification: string;
  plan: string[];
  compatibility: string;
  risk: string;
  requiredChecks: string[];
}): string {
  return [
    output.reason,
    '',
    '## Evidence',
    '',
    ...output.evidence.map((item) => `- ${item}`),
    '',
    '## Specification',
    '',
    output.specification,
    '',
    '## Implementation plan',
    '',
    ...output.plan.map((item) => `- ${item}`),
    '',
    '## Compatibility and risk',
    '',
    `**Compatibility:** ${output.compatibility}`,
    `**Risk:** ${output.risk}`,
    '',
    '## Required checks',
    '',
    ...output.requiredChecks.map((item) => `- ${item}`),
  ].join('\n');
}

function formatCommandOutput(command: string, exitCode: number, stdout: string, stderr: string): string {
  const transcript = truncate([stdout.trimEnd(), stderr.trimEnd()].filter(Boolean).join('\n'), 20_000);
  return [
    '## Command',
    '',
    indent(command),
    '',
    `Exit code: \`${exitCode}\``,
    '',
    '## Output',
    '',
    indent(transcript || '(no output)'),
  ].join('\n');
}

function formatReview(output: {
  summary: string;
  completeness: string;
  concerns: string[];
  sideEffectRisk: string;
  performanceRisk: string;
  compatibilityRisk: string;
}): string {
  const concerns = output.concerns.length > 0
    ? ['## Concerns', '', ...output.concerns.map((concern) => `- ${concern}`), '']
    : [];
  return [
    output.summary,
    '',
    `**Completeness:** ${output.completeness}`,
    `**Side-effect risk:** ${output.sideEffectRisk}`,
    `**Performance risk:** ${output.performanceRisk}`,
    `**Compatibility risk:** ${output.compatibilityRisk}`,
    '',
    ...concerns,
  ].join('\n').trimEnd();
}

function indent(value: string): string {
  return value.split('\n').map((line) => `    ${line}`).join('\n');
}

function truncate(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}\n\n[output truncated at ${limit} characters]`;
}
