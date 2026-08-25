/**
 * Where the Claude nodes earn their place: a triage pipeline that mixes shell,
 * model and plain code, and stays a program the whole way through.
 *
 * Run with `bun run examples/triage.ts`.
 */
import { definePipeline, z } from '../src/index.ts';

const Finding = z.object({
  file: z.string(),
  line: z.number().int().min(1),
  severity: z.enum(['low', 'medium', 'high']),
  summary: z.string(),
});

const Review = z.object({
  verdict: z.enum(['ship', 'block']),
  findings: z.array(Finding),
});

const triage = definePipeline({
  name: 'triage',
  // A real schema, so a bad input fails before any node runs.
  input: z.object({ base: z.string().default('origin/main') }),
  // Defaults every Claude node inherits unless it overrides them.
  claude: {
    model: 'claude-sonnet-5',
    tools: ['Read', 'Grep', 'Glob'],
    permissionMode: 'dontAsk',
  },
  run: async (ctx) => {
    const diff = await ctx.exec({
      name: 'diff',
      command: `git diff ${ctx.input.base}...HEAD --unified=3`,
    });

    // Plain code decides whether the expensive part is worth running at all.
    // A `step` is a node too, so the decision shows up in the graph and journal.
    const sized = await diff.step({
      name: 'measure',
      run: ({ log }) => {
        const lines = diff.stdout.split('\n').length;
        log(`diff is ${lines} lines`);
        return { lines, worthReviewing: lines > 10 };
      },
    });

    if (!sized.value.worthReviewing) return { verdict: 'ship' as const, findings: [] };

    // `output` turns the model's answer into validated, typed data — the rest of
    // the pipeline branches on a value, not on prose.
    const review = await sized.claude({
      name: 'review',
      prompt: [
        'Review the staged changes on this branch for correctness bugs only.',
        'Ignore style. Report a finding only if you can name the input that breaks it.',
        '',
        diff.stdout.slice(0, 40_000),
      ].join('\n'),
      output: Review,
      maxTurns: 20,
      timeout: 10 * 60_000,
    });

    const blocking = review.output.findings.filter((f) => f.severity === 'high');
    if (blocking.length === 0) return review.output;

    // Fan out one verifier per blocking finding. Each is an independent node, so
    // they are bounded by the `claude` concurrency limit and cached separately.
    const verdicts = await Promise.all(
      blocking.map((finding, index) =>
        review.claude({
          name: `verify-${index}`,
          prompt: `Try to refute this finding by reading the code. Finding: ${JSON.stringify(finding)}`,
          output: z.object({ refuted: z.boolean(), reason: z.string() }),
          maxTurns: 15,
        }),
      ),
    );

    const confirmed = blocking.filter((_, index) => !verdicts[index]!.output.refuted);
    ctx.log(`${confirmed.length}/${blocking.length} high-severity findings survived verification`);

    return { verdict: confirmed.length > 0 ? ('block' as const) : ('ship' as const), findings: confirmed };
  },
});

const run = await triage.run({ base: process.argv[2] ?? 'origin/main' });
console.log(JSON.stringify(run.value, null, 2));
console.error(`\n${run.nodes.length} nodes · $${run.costUsd.toFixed(4)} · resume with --resume ${run.runId}`);
