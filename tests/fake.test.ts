import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { definePipeline, fake, session } from '../src/index.ts';

const pipeline = definePipeline({
  name: 'implement-issue',
  input: z.object({ issueId: z.number() }),
  steps: ['classify', 'apply-labels', 'analyze', 'block', 'implement'],
  async run(ctx) {
    const effects: string[] = [];
    const classify = await ctx.claude({
      name: 'classify',
      prompt: `Classify issue ${ctx.input.issueId}.`,
      output: z.object({ type: z.enum(['bug', 'feature', 'chore']), labels: z.array(z.string()) }),
    });

    await ctx.step('apply-labels', () => void effects.push(`labels:${classify.output.labels}`));

    const analysis = await ctx.claude({
      name: 'analyze',
      prompt: 'Analyse feasibility.',
      output: z.object({ viable: z.boolean(), reason: z.string() }),
      retry: 2,
    });

    if (!analysis.output.viable) {
      await ctx.step('block', () => void effects.push(`block:${analysis.output.reason}`));
      ctx.halt('not viable');
    }

    const impl = await ctx.claude({
      name: 'implement',
      prompt: 'Implement it.',
      output: z.object({ summary: z.string() }),
    });
    return { effects, summary: impl.output.summary };
  },
});

describe('fake()', () => {
  test('drives the whole pipeline from fixture Outputs', async () => {
    const claude = fake({
      classify: { type: 'bug', labels: ['bug'] },
      analyze: { viable: true, reason: 'clear enough' },
      implement: { summary: 'fixed the off-by-one' },
    });

    const result = await pipeline.run({ input: { issueId: 42 }, claude });

    expect(result.status).toBe('completed');
    expect(result.output).toEqual({
      effects: ['labels:bug'],
      summary: 'fixed the off-by-one',
    });
    expect(claude.calls.map((c) => c.stepName)).toEqual(['classify', 'analyze', 'implement']);
    expect(claude.calls[0]!.prompt).toContain('42');
  });

  test('a different fixture takes the other branch', async () => {
    const claude = fake({
      classify: { type: 'chore', labels: [] },
      analyze: { viable: false, reason: 'underspecified' },
    });

    const result = await pipeline.run({ input: { issueId: 7 }, claude });

    expect(result.status).toBe('halted');
    expect(result.haltReason).toBe('not viable');
    expect(result.steps.find((s) => s.name === 'implement')?.status).toBe('skipped');
    expect(result.steps.find((s) => s.name === 'block')?.status).toBe('completed');
    expect(claude.calls.map((c) => c.stepName)).toEqual(['classify', 'analyze']);
  });

  test('an Error fixture fails the session, and a list feeds successive attempts', async () => {
    const claude = fake({
      classify: { type: 'bug', labels: [] },
      analyze: [new Error('session died'), { viable: true, reason: 'fine' }],
      implement: { summary: 'done' },
    });

    const result = await pipeline.run({ input: { issueId: 1 }, claude });
    expect(result.status).toBe('completed');
    expect(claude.calls.filter((c) => c.stepName === 'analyze')).toHaveLength(2);
  });

  test('a fixture that does not satisfy the schema fails the step', async () => {
    const claude = fake({ classify: { type: 'nonsense', labels: [] } });
    const result = await pipeline.run({ input: { issueId: 1 }, claude });
    expect(result.status).toBe('failed');
    expect(result.error).toContain('classify');
  });

  test('a missing fixture is a clear error, not a silent empty Output', async () => {
    const claude = fake({ classify: { type: 'bug', labels: [] } });
    const result = await pipeline.run({ input: { issueId: 1 }, claude });
    expect(result.status).toBe('failed');
    expect(result.error).toContain('no fixture for step "analyze"');
  });

  test('a string fixture is the final text of a step with no schema', async () => {
    const prose = definePipeline({
      name: 'prose',
      async run(ctx) {
        return (await ctx.claude({ name: 'summarise', prompt: 'Summarise.' })).text;
      },
    });

    const result = await prose.run({ input: undefined, claude: fake({ summarise: 'a summary' }) });
    expect(result.output).toBe('a summary');
  });

  test('session() sets text, session id and passed-through messages', async () => {
    const seen: unknown[] = [];
    const prose = definePipeline({
      name: 'prose',
      async run(ctx) {
        return await ctx.claude({ name: 'summarise', prompt: 'Summarise.' });
      },
    });

    const result = await prose.run({
      input: undefined,
      claude: fake({
        summarise: session({
          text: 'a summary',
          sessionId: 'abc',
          messages: [{ type: 'assistant' } as never],
        }),
      }),
      on: { message: (m) => void seen.push(m) },
    });

    expect(result.steps[0]!.sessionId).toBe('abc');
    expect(result.steps[0]!.text).toBe('a summary');
    expect(seen).toEqual([{ type: 'assistant' }]);
  });

  test('a function fixture can answer from the request', async () => {
    const prose = definePipeline({
      name: 'prose',
      async run(ctx) {
        return (await ctx.claude({ name: 'echo', prompt: 'the prompt' })).text;
      },
    });

    const result = await prose.run({
      input: undefined,
      claude: fake({ echo: (request) => `saw: ${request.prompt}` }),
    });
    expect(result.output).toBe('saw: the prompt');
  });
});
