import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { ClaudeStepError, definePipeline } from '../src/index.ts';
import type { ClaudeRequest, ClaudeResponse, ClaudeRunner } from '../src/index.ts';

/** A hand-rolled runner, so these tests never open a session. */
function recording(
  responses: (ClaudeResponse | Error)[],
): { runner: ClaudeRunner; requests: ClaudeRequest[] } {
  const requests: ClaudeRequest[] = [];
  let i = 0;
  const runner: ClaudeRunner = async (request) => {
    requests.push(request);
    const next = responses[Math.min(i++, responses.length - 1)];
    if (next instanceof Error) throw next;
    return next!;
  };
  return { runner, requests };
}

describe('claude steps', () => {
  test('validates structured_output against the declared schema', async () => {
    const { runner, requests } = recording([
      {
        finalMessage: 'done',
        structuredOutput: { type: 'bug', labels: ['bug'] },
        sessionId: 's1',
      },
    ]);

    const pipeline = definePipeline({
      name: 'classify',
      async run(ctx) {
        const classify = await ctx.claude({
          name: 'classify',
          prompt: 'Classify it.',
          output: z.object({ type: z.enum(['bug', 'feature']), labels: z.array(z.string()) }),
        });
        return classify.output;
      },
    });

    const result = await pipeline.run({ input: undefined, claude: runner });
    expect(result.status).toBe('completed');
    expect(result.output).toEqual({ type: 'bug', labels: ['bug'] });
    expect(result.steps[0]!.kind).toBe('claude');
    expect(result.steps[0]!.sessionId).toBe('s1');
    expect(result.steps[0]!.output).toEqual({ type: 'bug', labels: ['bug'] });
    expect(requests[0]!.jsonSchema).toBeDefined();
    expect(requests[0]!.jsonSchema!.type).toBe('object');
    // The CLI rejects a schema carrying the 2020-12 meta-schema URL it cannot resolve.
    expect(requests[0]!.jsonSchema).not.toHaveProperty('$schema');
  });

  test('without a schema the handle carries the final message', async () => {
    const { runner, requests } = recording([{ finalMessage: 'a paragraph of prose' }]);

    const pipeline = definePipeline({
      name: 'prose',
      async run(ctx) {
        const summary = await ctx.claude({ name: 'summarise', prompt: 'Summarise.' });
        return summary.finalMessage;
      },
    });

    const result = await pipeline.run({ input: undefined, claude: runner });
    expect(result.output).toBe('a paragraph of prose');
    expect(requests[0]!.jsonSchema).toBeUndefined();
  });

  test('an Output that does not satisfy the schema fails the step', async () => {
    const { runner } = recording([
      { finalMessage: '', structuredOutput: { type: 'nonsense' } },
    ]);

    const pipeline = definePipeline({
      name: 'bad-output',
      async run(ctx) {
        await ctx.claude({
          name: 'classify',
          prompt: 'Classify it.',
          output: z.object({ type: z.enum(['bug', 'feature']) }),
        });
      },
    });

    const result = await pipeline.run({ input: undefined, claude: runner });
    expect(result.status).toBe('failed');
    expect((result.cause as Error).cause).toBeInstanceOf(ClaudeStepError);
  });

  test('a declared schema with no structured_output fails the step', async () => {
    const { runner } = recording([{ finalMessage: 'I forgot to answer' }]);

    const pipeline = definePipeline({
      name: 'missing-output',
      async run(ctx) {
        await ctx.claude({
          name: 'classify',
          prompt: 'Classify it.',
          output: z.object({ type: z.string() }),
        });
      },
    });

    const result = await pipeline.run({ input: undefined, claude: runner });
    expect(result.status).toBe('failed');
    expect(result.error).toContain('structured_output');
  });

  test('retry:n retries the whole session and then succeeds', async () => {
    const { runner, requests } = recording([
      new Error('session died'),
      new Error('session died again'),
      { finalMessage: 'ok', structuredOutput: { viable: true } },
    ]);

    const pipeline = definePipeline({
      name: 'retrying',
      async run(ctx) {
        const a = await ctx.claude({
          name: 'analyze',
          prompt: 'Analyse.',
          output: z.object({ viable: z.boolean() }),
          retry: 2,
        });
        return a.output;
      },
    });

    const result = await pipeline.run({ input: undefined, claude: runner });
    expect(result.status).toBe('completed');
    expect(result.output).toEqual({ viable: true });
    expect(requests).toHaveLength(3);
    expect(result.steps[0]!.attempts).toBe(3);
  });

  test('retry:n gives up after n extra attempts', async () => {
    const { runner, requests } = recording([new Error('session died')]);

    const pipeline = definePipeline({
      name: 'retry-exhausted',
      steps: ['analyze', 'after'],
      async run(ctx) {
        await ctx.claude({ name: 'analyze', prompt: 'Analyse.', retry: 2 });
        await ctx.step('after', () => 'never');
      },
    });

    const result = await pipeline.run({ input: undefined, claude: runner });
    expect(result.status).toBe('failed');
    expect(requests).toHaveLength(3);
    expect(result.error).toContain('after 3 attempt(s)');
    expect(result.steps).toHaveLength(1);
  });

  test('no retry means exactly one attempt', async () => {
    const { runner, requests } = recording([new Error('session died')]);
    const pipeline = definePipeline({
      name: 'no-retry',
      async run(ctx) {
        await ctx.claude({ name: 'analyze', prompt: 'Analyse.' });
      },
    });

    const result = await pipeline.run({ input: undefined, claude: runner });
    expect(result.status).toBe('failed');
    expect(requests).toHaveLength(1);
  });

  test('defaults bypassPermissions, all skills, project settings and the workspace cwd', async () => {
    const { runner, requests } = recording([{ finalMessage: 'ok' }]);
    const pipeline = definePipeline({
      name: 'defaults',
      async run(ctx) {
        await ctx.claude({ name: 'a', prompt: 'go' });
        await ctx.claude({ name: 'b', prompt: 'go', cwd: '/elsewhere', model: 'other-model' });
      },
    });

    await pipeline.run({ input: undefined, workspace: '/work', model: 'run-model', claude: runner });

    expect(requests[0]).toMatchObject({
      permissionMode: 'bypassPermissions',
      skills: 'all',
      settingSources: ['project'],
      cwd: '/work',
      model: 'run-model',
    });
    expect(requests[1]).toMatchObject({ cwd: '/elsewhere', model: 'other-model' });
  });

  test('branch logic is assertable against fixture Outputs', async () => {
    const effects: string[] = [];
    const pipeline = definePipeline({
      name: 'branching',
      steps: ['analyze', 'block', 'implement'],
      async run(ctx) {
        const analysis = await ctx.claude({
          name: 'analyze',
          prompt: 'Analyse.',
          output: z.object({ viable: z.boolean(), reason: z.string() }),
        });
        if (!analysis.output.viable) {
          await ctx.step('block', () => void effects.push(`block:${analysis.output.reason}`));
          ctx.halt('not viable');
        }
        await ctx.step('implement', () => void effects.push('implement'));
      },
    });

    const notViable = await pipeline.run({
      input: undefined,
      claude: recording([
        { finalMessage: '', structuredOutput: { viable: false, reason: 'too vague' } },
      ])
        .runner,
    });
    expect(notViable.status).toBe('halted');
    expect(effects).toEqual(['block:too vague']);
    expect(notViable.steps.find((s) => s.name === 'implement')?.status).toBe('skipped');

    effects.length = 0;
    const viable = await pipeline.run({
      input: undefined,
      claude: recording([
        { finalMessage: '', structuredOutput: { viable: true, reason: 'clear' } },
      ]).runner,
    });
    expect(viable.status).toBe('completed');
    expect(effects).toEqual(['implement']);
  });
});
