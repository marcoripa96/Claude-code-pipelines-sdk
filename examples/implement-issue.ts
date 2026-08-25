/**
 * The worked example from docs/design.md: classify → analyze → implement → review.
 *
 * Claude acts on the workspace — it reads the code, writes the fix, runs the tests.
 * Every label, comment and block below is performed by this file, from an Output.
 *
 *   bun run examples/implement-issue.ts          # fixture Outputs, no session
 *   bun run examples/implement-issue.ts --real   # real sessions in a real workspace
 */
import { definePipeline, fake, sqliteStorage } from '@marcoripa96/claude-code-pipelines-sdk';
import { z } from 'zod';
import { tracker } from './tracker.ts';

export const implementIssue = definePipeline({
  name: 'implement-issue',
  input: z.object({
    issueId: z.number(),
    /** How this workspace runs its tests. Named here so a test can point it somewhere safe. */
    testCommand: z.string().default('bun test'),
  }),
  steps: [
    'fetch-issue',
    'classify',
    'apply-labels',
    'analyze',
    'block',
    'implement',
    'test',
    'review',
    'report',
  ],

  async run(ctx) {
    const issue = await ctx.step('fetch-issue', () => tracker.get(ctx.input.issueId));

    const classify = await ctx.claude({
      name: 'classify',
      prompt: `Classify this issue.\n\nTitle: ${issue.title}\n\n${issue.body}`,
      output: z.object({
        type: z.enum(['bug', 'feature', 'chore']),
        labels: z.array(z.string()),
      }),
    });

    await ctx.step('apply-labels', () =>
      tracker.addLabels(ctx.input.issueId, classify.output.labels),
    );

    const analysis = await ctx.claude({
      name: 'analyze',
      prompt:
        `This is a ${classify.output.type}. Read the code and judge whether it can be ` +
        `implemented as described, then write a plan.\n\n${issue.body}`,
      output: z.object({
        viable: z.boolean(),
        reason: z.string(),
        plan: z.string(),
      }),
      retry: 2,
    });

    // The branch is here, in code, on a value — not inside a model turn.
    if (!analysis.output.viable) {
      await ctx.step('block', () => tracker.block(ctx.input.issueId, analysis.output.reason));
      ctx.halt('not viable');
    }

    const impl = await ctx.claude({
      name: 'implement',
      prompt: `Implement this plan:\n\n${analysis.output.plan}`,
      output: z.object({
        summary: z.string(),
        filesChanged: z.array(z.string()),
      }),
    });

    const tests = await ctx.command({
      name: 'test',
      command: ctx.input.testCommand,
      allowFailure: true,
    });

    const review = await ctx.claude({
      name: 'review',
      prompt:
        `Review the change just made.\n\n${impl.output.summary}\n\n` +
        `Files: ${impl.output.filesChanged.join(', ')}\n\n` +
        `The test suite exited ${tests.exitCode}.\n${tests.stdout}${tests.stderr}`,
      output: z.object({
        approved: z.boolean(),
        concerns: z.array(z.string()),
      }),
    });

    await ctx.step('report', () =>
      tracker.comment(
        ctx.input.issueId,
        review.output.approved
          ? `Implemented: ${impl.output.summary}`
          : `Needs work: ${review.output.concerns.join('; ')}`,
      ),
    );

    return {
      approved: review.output.approved,
      summary: impl.output.summary,
      filesChanged: impl.output.filesChanged,
      testsPassed: tests.exitCode === 0,
    };
  },
});

if (import.meta.main) {
  const real = process.argv.includes('--real');

  const result = await implementIssue.run({
    input: { issueId: 42 },
    workspace: real ? (process.env.WORKSPACE ?? process.cwd()) : process.cwd(),
    storage: sqliteStorage('.pipelines/runs.sqlite'),
    on: {
      stepStarted: (step) => console.log('▶', step.name),
      stepFinished: (step) => console.log('✔', step.name, step.status, `${step.durationMs}ms`),
    },
    // Without --real the pipeline runs end to end on fixture Outputs.
    claude: real
      ? undefined
      : fake({
          classify: { type: 'bug', labels: ['bug', 'timezones'] },
          analyze: {
            viable: true,
            reason: 'The formatter is reachable and the fix is local.',
            plan: 'Format digest dates in the user timezone rather than UTC.',
          },
          implement: {
            summary: 'Formatted digest dates in the recipient timezone.',
            filesChanged: ['src/digest/format.ts'],
          },
          review: { approved: true, concerns: [] },
        }),
  });

  console.log(`\n${result.status}:`, result.output ?? result.error ?? result.haltReason);
}
