import {
  definePipeline,
  isHalt,
  type ClaudeHandle,
} from '@marcoripa96/claude-code-pipelines-sdk';
import { z } from 'zod';
import {
  RISK_LEVELS,
  type CommitUnderReview,
  type KanbyFactoryDependencies,
  type RiskLevel,
} from './contracts.ts';
import {
  describe,
  formatAnalysis,
  formatClassification,
  formatCommandOutput,
  formatReview,
  label,
  mergeRequestDescription,
  peakRisk,
  rank,
  withRound,
} from './format.ts';

const risk = z.enum(RISK_LEVELS);

const input = z.object({
  taskGuid: z.string().min(1),
  testCommand: z.string().min(1).default('bun test'),
  maxRevisions: z.number().int().min(0).max(5).default(1),
  /** Below this, classification is a question for a human rather than an answer. */
  minConfidence: z.number().min(0).max(1).default(0.8),
  /**
   * The highest review risk that may reach a merge request unattended. Above it the
   * factory stops and a human decides — the pipeline's version of review depth
   * scaling with risk.
   */
  maxUnattendedRisk: risk.default('medium'),
  /**
   * A change larger than this is handed to a human rather than scored by a model.
   *
   * Optional, and off when omitted: a ceiling is a statement about how much diff *your*
   * reviewing model reads usefully, and there is no honest default for that. Set it when
   * you have one.
   */
  maxDiffBytes: z.number().int().min(1).optional(),
  gitlab: z.object({
    host: z.string().url(),
    project: z.string().min(1),
    sourceBranch: z.string().min(1),
    targetBranch: z.string().min(1).default('main'),
  }),
});

/** The two preparation outputs that make a `todo` task self-contained. */
const PREPARATION_KEYS = [
  'kanby-software-factory/classification',
  'kanby-software-factory/analysis',
];

/**
 * One pipeline for every open task: it reads where the task is on the board and
 * runs exactly the stages that stage still needs. A `backlog` task goes through
 * intake (classify -> analyze -> brief -> todo) and straight on into delivery; a
 * `todo` task skips intake and starts at implementation.
 *
 * Step boundaries follow one rule: a step has exactly one observable outcome —
 * a decision (a Claude Output), one transition of one system of record, or a
 * gate verdict. The rule is not taste: a step is the SDK's unit of record,
 * retry, timeout and replay at once, so two systems of record in one step could
 * not be retried without repeating half of it.
 *
 * Every way this pipeline stops after claiming — a gate, or a thrown step —
 * runs the same handoff ritual (`handoff-block` -> `handoff-release`), so a
 * stopped run never leaves the card claimed by an agent that is gone.
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
    /**
     * What every step here does when a crashed run left it in flight and nobody knows
     * whether it landed (ADR 0009). `ctx.step` alone defaults to stopping and asking a
     * human, which is right for an unknown effect and wrong for every effect in this
     * pipeline but one.
     *
     * Every board write below is a set-operation — move, block, release, upsert an
     * output, overwrite the content — so doing it twice is doing it once. Git and GitLab
     * are the same by construction: `commit` recognises its own marker on HEAD, `push`
     * pushes a sha that is already there, and `ensure` finds the merge request before it
     * creates one. These are properties of the adapters, and this is where the pipeline
     * says once that it relies on them.
     *
     * The exception is `claim`, which is guarded on the snapshot it was read from and so
     * says for itself how to settle the question.
     */
    defaults: { onCrash: 'rerun' },
    steps: [
      'fetch-task',
      'claim',
      'classify',
      'publish-classification',
      'analyze',
      'publish-analysis',
      'write-brief',
      'move-todo',
      // One system of record per step, gates included: a failure names the system
      // that is not provisioned rather than "preflight".
      'preflight-git',
      'preflight-gitlab',
      'move-in-progress',
      'implement',
      'publish-implementation',
      'verify-commit',
      'check',
      'publish-checks',
      'review',
      'publish-review',
      'push',
      'open-merge-request',
      'link-development',
      'move-in-review',
      'release',
      // The shared handoff ritual. Declared last because any stop may run it;
      // revision rounds re-run the loop's seven steps under a `-2`, `-3`, ...
      // suffix, which stays undeclared by design.
      'handoff-block',
      'handoff-release',
    ],

    async run(ctx) {
      const task = await ctx.step('fetch-task', (signal) =>
        kanby.get(ctx.input.taskGuid, ctx.workspace, signal),
      );

      // Every guard that the fetched snapshot alone can decide runs before the
      // claim, so refusing a task never has to undo one.
      if (task.blocked) ctx.halt(`task is blocked: ${task.blocked.reason}`);
      if (task.status !== 'backlog' && task.status !== 'todo') {
        ctx.halt(`factory requires backlog or todo, got ${task.status}`);
      }
      const intake = task.status === 'backlog';
      if (!intake && !PREPARATION_KEYS.every((key) => task.outputKeys.includes(key))) {
        ctx.halt('todo task is missing preparation outputs');
      }

      await ctx.step(
        'claim',
        async (signal) => {
          await kanby.claim(task, ctx.workspace, signal);
          return 'claimed' as const;
        },
        {
          // The one effect here that is not repeatable: `kanby claim` is guarded on the
          // snapshot it was read from, so repeating it after a crash fails rather than
          // duplicating. The board already knows the answer, so a recovered run asks.
          reconcile: async (signal) => {
            const current = await kanby.get(task.guid, ctx.workspace, signal);
            return current.claimedBy === kanby.actor ? ('claimed' as const) : undefined;
          },
        },
      );
      const taskLabel = label(task);

      /**
       * Every way this run stops after the claim ends here: record why on the card,
       * then leave the card free for a human to act on. One implementation, because it
       * is one invariant — a stop always releases the claim.
       *
       * `bestEffort` is the failing-run path. There, a board that is itself unreachable
       * must not replace the error that got us here: a card left claimed is visible on
       * the board, a swallowed cause is not.
       */
      const handOff = async (reason: string, { bestEffort = false } = {}): Promise<void> => {
        const attempt = async (effect: () => Promise<unknown>): Promise<void> => {
          if (!bestEffort) {
            await effect();
            return;
          }
          try {
            await effect();
          } catch {
            // Deliberately swallowed; see above.
          }
        };
        await attempt(() =>
          ctx.step('handoff-block', (signal) =>
            kanby.block(task.guid, reason, ctx.workspace, signal),
          ),
        );
        await attempt(() =>
          ctx.step('handoff-release', (signal) =>
            kanby.release(task.guid, ctx.workspace, signal),
          ),
        );
      };

      /** The gate form: hand off, then end the run successfully at the gate's reason. */
      const handOffToHuman = (reason: string): Promise<never> =>
        handOff(reason).then(() => ctx.halt(reason));

      try {
        await stages();
      } catch (error) {
        if (isHalt(error)) throw error;
        // A thrown step is the factory's other way of stopping — usually something it
        // needs is not provisioned. Same ritual, best-effort, and the original error
        // still fails the run.
        await handOff(`Run failed: ${describe(error)}`, { bestEffort: true });
        throw error;
      }

      async function stages(): Promise<void> {
        let brief = task.content.trim();
        let type: string | undefined;

        if (intake) {
          const classification = await ctx.claude({
            name: 'classify',
            prompt:
              `You are classifying kanby task ${taskLabel}.\n\n` +
              `1. Read the task: kanby show ${task.guid}\n` +
              `2. Decide its type, your confidence, and whether it needs human triage ` +
              `before any technical work.\n\n` +
              `Answer through the structured output.`,
            output: z.object({
              type: z.enum(['bug', 'feature', 'documentation', 'chore']),
              confidence: z.number().min(0).max(1),
              rationale: z.string(),
              requiresHumanTriage: z.boolean(),
            }),
          });
          type = classification.output.type;

          await ctx.step('publish-classification', (signal) =>
            kanby.putOutput(
              task.guid,
              {
                key: PREPARATION_KEYS[0]!,
                title: 'Classification',
                body: formatClassification(classification.output),
              },
              ctx.workspace,
              signal,
            ),
          );
          if (
            classification.output.requiresHumanTriage ||
            classification.output.confidence < ctx.input.minConfidence
          ) {
            const reason = classification.output.requiresHumanTriage
              ? `Classification requires human triage: ${classification.output.rationale}`
              : `Classification confidence is ${classification.output.confidence}: ${classification.output.rationale}`;
            await handOffToHuman(reason);
          }

          const analysis = await ctx.claude({
            name: 'analyze',
            prompt:
              `You are analysing kanby task ${taskLabel} (classified as a ` +
              `${classification.output.type}) to decide whether it is ready to be ` +
              `implemented.\n\n` +
              `1. Read the task: kanby show ${task.guid}\n` +
              `2. Ground yourself in the actual repository. Run throwaway probes where ` +
              `reading is not enough, and leave the workspace exactly as you found it.\n` +
              `3. Quote the probe you ran as evidence, so the implementer can re-run it ` +
              `rather than trust it.\n` +
              `4. Say what you could not verify instead of inventing it; put verification ` +
              `first in the plan when something material is unconfirmed.\n` +
              `5. Produce evidence, specification, plan, compatibility and risk through ` +
              `the structured output.`,
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
            // The only session whose Output gates a column move, and the only one
            // whose work a human cannot cheaply redo from the card.
            retry: 2,
          });
          brief = formatAnalysis(analysis.output, classification.output.type);

          await ctx.step('publish-analysis', (signal) =>
            kanby.putOutput(
              task.guid,
              {
                key: PREPARATION_KEYS[1]!,
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
          // The brief is the authoritative copy from here on: a human editing it
          // during a restart changes what the implementer reads, and the Analysis
          // block stays as the record of what the factory originally proposed.
          await ctx.step('write-brief', (signal) =>
            kanby.update(task.guid, { content: brief }, ctx.workspace, signal),
          );
          await ctx.step('move-todo', (signal) =>
            kanby.move(task.guid, 'todo', ctx.workspace, signal),
          );
        }

        await ctx.step('preflight-git', (signal) =>
          repository.preflight(ctx.workspace, ctx.input.gitlab, signal),
        );
        await ctx.step('preflight-gitlab', (signal) =>
          mergeRequests.preflight(ctx.input.gitlab, signal),
        );
        await ctx.step('move-in-progress', (signal) =>
          kanby.move(task.guid, 'in_progress', ctx.workspace, signal),
        );

        // The last round's verdict and the commit it was passed. Both leave the loop,
        // because what the gate below decides about, and what `push` publishes, is
        // whatever the final round settled on.
        let review!: ClaudeHandle<{
          summary: string;
          completeness: 'complete' | 'partial' | 'missing';
          concerns: string[];
          sideEffectRisk: RiskLevel;
          performanceRisk: RiskLevel;
          compatibilityRisk: RiskLevel;
        }>;
        let reviewed!: CommitUnderReview;
        for (let round = 1; ; round++) {
          // Every step in the loop carries the round, so a two-round run reads as
          // fourteen distinct records rather than seven names appearing twice.
          const suffix = round === 1 ? '' : `-${round}`;
          const implementation = await ctx.claude({
            name: `implement${suffix}`,
            prompt: round === 1
              ? `You are implementing kanby task ${taskLabel}.\n\n` +
                `1. Read the task: kanby show ${task.guid} — its content is the prepared brief.\n` +
                `2. Implement the brief in this workspace, as written. If the brief turns out ` +
                `to be wrong, follow it as far as it holds and say so in your summary.\n` +
                `3. Commit your work on branch ${ctx.input.gitlab.sourceBranch}, referencing ` +
                `${taskLabel} in the message, and leave the workspace clean. Only what you ` +
                `commit is reviewed, and only what passes review is published.\n` +
                `4. Do not push, do not open a merge request, and do not write to the board. ` +
                `A risk gate reads your commit first, and the pipeline publishes what clears ` +
                `it.\n\n` +
                `Summarise what you did through the structured output.`
              : `You are revising kanby task ${taskLabel} after review round ${round - 1} ` +
                `flagged concerns.\n\n` +
                `1. Read the task: kanby show ${task.guid} — its content is the prepared ` +
                `brief, and its Review output holds the concerns to address.\n` +
                `2. Revise the implementation in this workspace.\n` +
                `3. Commit the revision on branch ${ctx.input.gitlab.sourceBranch} and leave ` +
                `the workspace clean.\n` +
                `4. Do not push, do not open a merge request, and do not write to the board.\n\n` +
                `Summarise the revision through the structured output.`,
            output: z.object({ summary: z.string() }),
          });

          await ctx.step(`publish-implementation${suffix}`, (signal) =>
            kanby.putOutput(
              task.guid,
              {
                key: 'kanby-software-factory/implementation',
                title: 'Implementation',
                body: withRound(round, implementation.output.summary),
              },
              ctx.workspace,
              signal,
            ),
          );

          // What the session actually left, read back rather than taken on trust. From
          // here the change is one immutable object: `change.sha` is what the reviewer
          // scores and what `push` publishes, so the two cannot drift apart.
          reviewed = await ctx.step(`verify-commit${suffix}`, (signal) =>
            repository.verifyCommit(ctx.workspace, ctx.input.gitlab, signal),
          );
          const ceiling = ctx.input.maxDiffBytes;
          if (ceiling !== undefined && reviewed.diffBytes > ceiling) {
            await handOffToHuman(
              `Change is ${reviewed.diffBytes} bytes, larger than ${ceiling}, and was ` +
              `not reviewed`,
            );
          }

          const checked = await ctx.step(`check${suffix}`, (signal) =>
            checks.run(ctx.workspace, ctx.input.testCommand, signal),
          );
          await ctx.step(`publish-checks${suffix}`, (signal) =>
            kanby.putOutput(
              task.guid,
              {
                key: 'kanby-software-factory/checks',
                title: 'Checks',
                body: withRound(
                  round,
                  formatCommandOutput(
                    ctx.input.testCommand,
                    checked.exitCode,
                    checked.stdout,
                    checked.stderr,
                  ),
                ),
              },
              ctx.workspace,
              signal,
            ),
          );

          if (checked.exitCode !== 0) {
            await handOffToHuman(
              `Check command exited ${checked.exitCode}: ${ctx.input.testCommand}`,
            );
          }

          review = await ctx.claude({
            name: `review${suffix}`,
            prompt:
              `You are reviewing kanby task ${taskLabel} before a human reviewer does.\n\n` +
              `1. Read the task: kanby show ${task.guid} — its content is the prepared ` +
              `brief, and its Checks output holds the recorded check run.\n` +
              `2. Get the change: git diff ${reviewed.base} ${reviewed.sha}\n` +
              `3. Judge completeness against the brief and the change's side-effect, ` +
              `performance and compatibility risk. Your risk scores decide how much ` +
              `human attention this change gets, so score the change, not your ` +
              `confidence in it.\n\n` +
              `Review, do not fix. Answer through the structured output.`,
            output: z.object({
              summary: z.string(),
              completeness: z.enum(['complete', 'partial', 'missing']),
              concerns: z.array(z.string()),
              sideEffectRisk: risk,
              performanceRisk: risk,
              compatibilityRisk: risk,
            }),
          });

          await ctx.step(`publish-review${suffix}`, (signal) =>
            kanby.putOutput(
              task.guid,
              {
                key: 'kanby-software-factory/review',
                title: 'Review',
                body: withRound(round, formatReview(review.output)),
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

        // Review depth scales with risk. The board has one review column, so the
        // only depth this pipeline can express is "a human decides before this is
        // published at all" — and the scores the reviewer produced are what decides.
        const peak = peakRisk(review.output);
        if (rank(peak.level) > rank(ctx.input.maxUnattendedRisk)) {
          await handOffToHuman(
            `${peak.dimension} risk is ${peak.level}, above the unattended ceiling ` +
            `${ctx.input.maxUnattendedRisk}: a human decides before this is published`,
          );
        }

        // The first effect anyone outside this workspace can see, and the first one the
        // gate above has let through.
        await ctx.step('push', (signal) =>
          repository.push(ctx.workspace, ctx.input.gitlab, reviewed.sha, signal),
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
              description: mergeRequestDescription(task, review.output, type),
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
      }
    },
  });
}
