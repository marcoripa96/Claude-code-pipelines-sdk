import { describe, expect, test } from 'bun:test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CommandFailedError, definePipeline } from '../src/index.ts';

describe('command steps', () => {
  test('returns stdout, stderr and the exit code', async () => {
    const pipeline = definePipeline({
      name: 'echoes',
      async run(ctx) {
        const out = await ctx.command({ name: 'greet', command: 'echo hello' });
        return out;
      },
    });

    const result = await pipeline.run({ input: undefined });
    expect(result.status).toBe('completed');
    expect(result.output?.stdout.trim()).toBe('hello');
    expect(result.output?.exitCode).toBe(0);
    expect(result.steps[0]!.kind).toBe('command');
    expect(result.steps[0]!.exitCode).toBe(0);
  });

  test('a non-zero exit fails the run', async () => {
    const pipeline = definePipeline({
      name: 'failing-command',
      steps: ['fail', 'after'],
      async run(ctx) {
        await ctx.command({ name: 'fail', command: 'exit 3' });
        await ctx.step('after', () => 'never');
      },
    });

    const result = await pipeline.run({ input: undefined });
    expect(result.status).toBe('failed');
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]!.status).toBe('failed');
    expect(result.steps[0]!.exitCode).toBe(3);
    expect(result.cause).toBeInstanceOf(Error);
    expect((result.cause as Error).cause).toBeInstanceOf(CommandFailedError);
  });

  test('allowFailure hands the exit code back instead of throwing', async () => {
    const pipeline = definePipeline({
      name: 'tolerant-command',
      async run(ctx) {
        const lint = await ctx.command({
          name: 'lint',
          command: 'exit 1',
          allowFailure: true,
        });
        return lint.exitCode;
      },
    });

    const result = await pipeline.run({ input: undefined });
    expect(result.status).toBe('completed');
    expect(result.output).toBe(1);
  });

  test('runs in the workspace, and in a step override when given', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'pipelines-cwd-'));
    const other = await mkdtemp(join(tmpdir(), 'pipelines-other-'));
    await writeFile(join(workspace, 'marker.txt'), 'in-workspace');
    await writeFile(join(other, 'marker.txt'), 'in-override');

    const pipeline = definePipeline({
      name: 'cwd',
      async run(ctx) {
        const a = await ctx.command({ name: 'read', command: 'cat marker.txt' });
        const b = await ctx.command({ name: 'read-other', command: 'cat marker.txt', cwd: other });
        return [a.stdout.trim(), b.stdout.trim()];
      },
    });

    const result = await pipeline.run({ input: undefined, workspace });
    expect(result.output).toEqual(['in-workspace', 'in-override']);
  });

  test('the step name defaults to the command', async () => {
    const pipeline = definePipeline({
      name: 'default-name',
      async run(ctx) {
        await ctx.command({ command: 'true' });
      },
    });

    const result = await pipeline.run({ input: undefined });
    expect(result.steps[0]!.name).toBe('true');
  });
});
