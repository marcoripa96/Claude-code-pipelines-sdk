import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { definePipeline, inputType, PipelineRunError, toMermaid, toText, z } from '../src/index.ts';
import { globToRegExp, hashInputs, stableStringify } from '../src/hash.ts';

const dirs: string[] = [];

async function workspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'pipeline-test-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('exec nodes', () => {
  test('captures stdout and exposes it as text', async () => {
    const cwd = await workspace();
    const pipeline = definePipeline({
      name: 'echo',
      cwd,
      reporter: false,
      run: async (ctx) => (await ctx.exec({ name: 'greet', command: 'echo hello' })).text,
    });

    const run = await pipeline.run();
    expect(run.value).toBe('hello');
    expect(run.nodes).toHaveLength(1);
    expect(run.nodes[0]!.status).toBe('success');
  });

  test('a non-zero exit fails the run and names the node', async () => {
    const cwd = await workspace();
    const pipeline = definePipeline({
      name: 'boom',
      cwd,
      reporter: false,
      run: (ctx) => ctx.exec({ name: 'fail', command: 'echo nope >&2; exit 3' }),
    });

    const result = await pipeline.tryRun();
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.message).toContain('exec:fail');
    expect(result.error.message).toContain('code 3');
    expect(result.nodes[0]!.status).toBe('failed');
    await expect(pipeline.run()).rejects.toBeInstanceOf(PipelineRunError);
  });

  test('allowFailure surfaces the exit code instead of throwing', async () => {
    const cwd = await workspace();
    const pipeline = definePipeline({
      name: 'tolerant',
      cwd,
      reporter: false,
      run: async (ctx) => (await ctx.exec({ name: 'probe', command: 'exit 7', allowFailure: true })).exitCode,
    });

    expect((await pipeline.run()).value).toBe(7);
  });

  test('stdin is forwarded to the command', async () => {
    const cwd = await workspace();
    const pipeline = definePipeline({
      name: 'stdin',
      cwd,
      reporter: false,
      run: async (ctx) => (await ctx.exec({ name: 'cat', command: 'cat', stdin: 'piped' })).text,
    });

    expect((await pipeline.run()).value).toBe('piped');
  });
});

describe('graph', () => {
  test('chaining off a result records the dependency edge', async () => {
    const cwd = await workspace();
    const pipeline = definePipeline({
      name: 'ci',
      cwd,
      reporter: false,
      run: async (ctx) => {
        const deps = await ctx.exec({ name: 'install', command: 'true' });
        await Promise.all([
          deps.exec({ name: 'lint', command: 'true' }),
          deps.exec({ name: 'test', command: 'true' }),
        ]);
      },
    });

    const run = await pipeline.run();
    expect(run.graph.edges).toEqual([
      { from: 'install', to: 'lint' },
      { from: 'install', to: 'test' },
    ]);
    expect(toMermaid(run.graph)).toContain('graph TD');
    expect(toText(run.graph)).toContain('lint <- install');
  });

  test('duplicate node names are rejected', async () => {
    const cwd = await workspace();
    const pipeline = definePipeline({
      name: 'dup',
      cwd,
      reporter: false,
      run: async (ctx) => {
        await ctx.exec({ name: 'same', command: 'true' });
        await ctx.exec({ name: 'same', command: 'true' });
      },
    });

    const result = await pipeline.tryRun();
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.message).toContain('duplicate node name');
  });

  test('nodes of the declared kind run at most `concurrency` at a time', async () => {
    const cwd = await workspace();
    let active = 0;
    let peak = 0;

    const pipeline = definePipeline({
      name: 'bounded',
      cwd,
      reporter: false,
      concurrency: { step: 2 },
      run: async (ctx) => {
        await Promise.all(
          [1, 2, 3, 4, 5].map((n) =>
            ctx.step({
              name: `work-${n}`,
              run: async () => {
                active += 1;
                peak = Math.max(peak, active);
                await new Promise((resolve) => setTimeout(resolve, 20));
                active -= 1;
              },
            }),
          ),
        );
      },
    });

    await pipeline.run();
    expect(peak).toBeLessThanOrEqual(2);
  });
});

describe('cache', () => {
  test('a node with declared inputs is skipped while those inputs are unchanged', async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, 'package.json'), '{"name":"x"}');
    let runs = 0;

    const pipeline = definePipeline({
      name: 'cached',
      cwd,
      reporter: false,
      run: async (ctx) => {
        await ctx.step({
          name: 'install',
          cache: { inputs: ['package.json'] },
          run: () => {
            runs += 1;
            return 'installed';
          },
        });
      },
    });

    await pipeline.run();
    const second = await pipeline.run();
    expect(runs).toBe(1);
    expect(second.nodes[0]!.status).toBe('cached');

    await writeFile(join(cwd, 'package.json'), '{"name":"y"}');
    const third = await pipeline.run();
    expect(runs).toBe(2);
    expect(third.nodes[0]!.status).toBe('success');
  });

  test('a changed parent invalidates its children', async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, 'lock'), 'v1');
    let childRuns = 0;

    const pipeline = definePipeline({
      name: 'invalidate',
      cwd,
      reporter: false,
      run: async (ctx) => {
        const parent = await ctx.step({ name: 'install', cache: { inputs: ['lock'] }, run: () => 'ok' });
        await parent.step({
          name: 'build',
          cache: true,
          run: () => {
            childRuns += 1;
            return 'built';
          },
        });
      },
    });

    await pipeline.run();
    await pipeline.run();
    expect(childRuns).toBe(1);

    await writeFile(join(cwd, 'lock'), 'v2');
    await pipeline.run();
    expect(childRuns).toBe(2);
  });

  test('force re-executes a named node and noCache disables the store', async () => {
    const cwd = await workspace();
    let runs = 0;
    const pipeline = definePipeline({
      name: 'force',
      cwd,
      reporter: false,
      run: async (ctx) => {
        await ctx.step({ name: 'once', cache: true, run: () => (runs += 1) });
      },
    });

    await pipeline.run();
    await pipeline.run();
    expect(runs).toBe(1);
    await pipeline.run(undefined, { force: ['once'] });
    expect(runs).toBe(2);
    await pipeline.run(undefined, { noCache: true });
    expect(runs).toBe(3);
  });
});

describe('resume', () => {
  test('a resumed run replays what already succeeded', async () => {
    const cwd = await workspace();
    let firstRuns = 0;
    let shouldFail = true;

    const pipeline = definePipeline({
      name: 'resumable',
      cwd,
      reporter: false,
      run: async (ctx) => {
        const first = await ctx.step({ name: 'prepare', run: () => (firstRuns += 1) });
        return first.step({
          name: 'flaky',
          run: () => {
            if (shouldFail) throw new Error('not yet');
            return 'done';
          },
        });
      },
    });

    const failed = await pipeline.tryRun();
    expect(failed.ok).toBe(false);
    expect(firstRuns).toBe(1);

    shouldFail = false;
    const resumed = await pipeline.run(undefined, { resumeFrom: failed.runId });
    expect(firstRuns).toBe(1);
    expect(resumed.nodes[0]!.status).toBe('replayed');
    expect(resumed.nodes[1]!.status).toBe('success');
    expect(resumed.value.value).toBe('done');
  });
});

describe('retry', () => {
  test('retries up to the configured attempt count', async () => {
    const cwd = await workspace();
    let attempts = 0;

    const pipeline = definePipeline({
      name: 'retry',
      cwd,
      reporter: false,
      run: (ctx) =>
        ctx.step({
          name: 'flaky',
          retry: { attempts: 3, backoffMs: 1 },
          run: () => {
            attempts += 1;
            if (attempts < 3) throw new Error('transient');
            return attempts;
          },
        }),
    });

    const run = await pipeline.run();
    expect(run.value.value).toBe(3);
    expect(run.nodes[0]!.attempts).toBe(3);
  });

  test('`when` can stop retrying early', async () => {
    const cwd = await workspace();
    let attempts = 0;

    const pipeline = definePipeline({
      name: 'retry-when',
      cwd,
      reporter: false,
      run: (ctx) =>
        ctx.step({
          name: 'fatal',
          retry: { attempts: 5, backoffMs: 1, when: (error) => !(error as Error).message.includes('fatal') },
          run: () => {
            attempts += 1;
            throw new Error('fatal error');
          },
        }),
    });

    await pipeline.tryRun();
    expect(attempts).toBe(1);
  });
});

describe('events', () => {
  test('every node emits start and end, and listeners can unsubscribe', async () => {
    const cwd = await workspace();
    const seen: string[] = [];
    const pipeline = definePipeline({
      name: 'events',
      cwd,
      reporter: false,
      run: async (ctx) => {
        ctx.log('starting');
        await ctx.exec({ name: 'noop', command: 'true' });
      },
    });

    const off = pipeline.on((event) => seen.push(event.type));
    await pipeline.run();
    expect(seen).toEqual(['run:start', 'log', 'node:start', 'node:end', 'run:end']);

    off();
    await pipeline.run();
    expect(seen).toHaveLength(5);
  });
});

describe('hashing', () => {
  test('key order does not change the serialization', () => {
    expect(stableStringify({ b: 1, a: 2 })).toBe(stableStringify({ a: 2, b: 1 }));
  });

  test('globs match the way a shell would', () => {
    expect(globToRegExp('src/**/*.ts').test('src/a/b/c.ts')).toBe(true);
    expect(globToRegExp('src/**/*.ts').test('src/c.ts')).toBe(true);
    expect(globToRegExp('src/*.ts').test('src/a/b.ts')).toBe(false);
    expect(globToRegExp('*.{ts,json}').test('bun.json')).toBe(true);
  });

  test('a pattern that matches nothing is still part of the key', async () => {
    const cwd = await workspace();
    const before = await hashInputs(cwd, ['src/**/*.ts']);
    expect(Object.values(before)).toEqual([null]);

    await Bun.write(join(cwd, 'src/a.ts'), 'export const a = 1;');
    const after = await hashInputs(cwd, ['src/**/*.ts']);
    expect(stableStringify(after)).not.toBe(stableStringify(before));
  });
});

describe('input', () => {
  test('a schema validates and normalizes the input before any node runs', async () => {
    const cwd = await workspace();
    let ran = false;

    const pipeline = definePipeline({
      name: 'validated',
      cwd,
      reporter: false,
      input: z.object({ base: z.string().default('origin/main'), depth: z.number().int() }),
      run: async (ctx) => {
        ran = true;
        return ctx.input;
      },
    });

    const run = await pipeline.run({ depth: 3 });
    expect(run.value).toEqual({ base: 'origin/main', depth: 3 });

    ran = false;
    const bad = await pipeline.tryRun({ depth: 1.5 } as never);
    expect(bad.ok).toBe(false);
    expect(ran).toBe(false);
    expect(bad.nodes).toHaveLength(0);
  });

  test('inputType types the input without validating it', async () => {
    const cwd = await workspace();
    const pipeline = definePipeline({
      name: 'typed',
      cwd,
      reporter: false,
      input: inputType<{ tag: string }>(),
      run: (ctx) => ctx.input.tag.toUpperCase(),
    });

    expect((await pipeline.run({ tag: 'v1' })).value).toBe('V1');
  });
});
