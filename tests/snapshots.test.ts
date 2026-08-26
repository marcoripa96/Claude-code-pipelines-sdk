import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { definePipeline, fake, gitWorkspaceSnapshots } from '../src/index.ts';
import type { StepRecord, WorkspaceSnapshots } from '../src/index.ts';

async function repository(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), 'snapshot-test-'));
  for (const args of [
    ['init', '-q', '-b', 'main'],
    ['config', 'user.email', 'test@localhost'],
    ['config', 'user.name', 'Test'],
  ]) {
    const child = Bun.spawn(['git', ...args], { cwd, stdout: 'ignore', stderr: 'ignore' });
    expect(await child.exited).toBe(0);
  }
  await writeFile(join(cwd, '.gitignore'), 'ignored/\n');
  return cwd;
}

const stubStep = (index = 0): StepRecord => ({
  id: 'step-id',
  runId: 'run-id',
  index,
  name: 'step',
  kind: 'code',
  status: 'completed',
  startedAt: 0,
});

const read = (cwd: string, path: string) => Bun.file(join(cwd, path)).text();

async function status(cwd: string): Promise<string> {
  const child = Bun.spawn(['git', 'status', '--porcelain'], { cwd, stdout: 'pipe' });
  return (await new Response(child.stdout).text()).trim();
}

describe('git workspace snapshots', () => {
  test('put back what was there, and remove what was not', async () => {
    const cwd = await repository();
    const snapshots = gitWorkspaceSnapshots();
    const signal = new AbortController().signal;

    await writeFile(join(cwd, 'kept.txt'), 'original');
    await mkdir(join(cwd, 'nested'), { recursive: true });
    await writeFile(join(cwd, 'nested', 'deep.txt'), 'deep');

    const snapshot = (await snapshots.capture({ workspace: cwd, runId: 'run-id', step: stubStep(), signal }))!;
    expect(snapshot).toContain(':');

    // Everything a step could do to a workspace: edit, add, delete.
    await writeFile(join(cwd, 'kept.txt'), 'changed');
    await writeFile(join(cwd, 'appeared.txt'), 'new');
    await rm(join(cwd, 'nested', 'deep.txt'));

    await snapshots.restore({ workspace: cwd, runId: 'run-id', step: stubStep(), snapshot, signal });

    expect(await read(cwd, 'kept.txt')).toBe('original');
    expect(await read(cwd, 'nested/deep.txt')).toBe('deep');
    expect(existsSync(join(cwd, 'appeared.txt'))).toBe(false);
  });

  test('staged state survives, and is not something restoring invents', async () => {
    const cwd = await repository();
    const snapshots = gitWorkspaceSnapshots();
    const signal = new AbortController().signal;

    await writeFile(join(cwd, 'staged.txt'), 'staged');
    await writeFile(join(cwd, 'loose.txt'), 'loose');
    const add = Bun.spawn(['git', 'add', 'staged.txt'], { cwd, stdout: 'ignore', stderr: 'ignore' });
    expect(await add.exited).toBe(0);
    const before = await status(cwd);

    const snapshot = (await snapshots.capture({ workspace: cwd, runId: 'run-id', step: stubStep(), signal }))!;

    // Capturing the workspace must not have staged the rest of it.
    expect(await status(cwd)).toBe(before);

    await writeFile(join(cwd, 'staged.txt'), 'trampled');
    await writeFile(join(cwd, 'loose.txt'), 'trampled');
    await snapshots.restore({ workspace: cwd, runId: 'run-id', step: stubStep(), snapshot, signal });

    expect(await read(cwd, 'staged.txt')).toBe('staged');
    expect(await read(cwd, 'loose.txt')).toBe('loose');
    // One file staged, one untracked — exactly as it was, not everything staged.
    expect(await status(cwd)).toBe(before);
  });

  test('ignored files cost nothing and are left alone', async () => {
    const cwd = await repository();
    const snapshots = gitWorkspaceSnapshots();
    const signal = new AbortController().signal;

    await mkdir(join(cwd, 'ignored'), { recursive: true });
    await writeFile(join(cwd, 'ignored', 'build.out'), 'artifact');

    const snapshot = (await snapshots.capture({ workspace: cwd, runId: 'run-id', step: stubStep(), signal }))!;
    await writeFile(join(cwd, 'ignored', 'build.out'), 'stale');
    await snapshots.restore({ workspace: cwd, runId: 'run-id', step: stubStep(), snapshot, signal });

    // Not captured, so not restored — and not deleted either.
    expect(await read(cwd, 'ignored/build.out')).toBe('stale');
  });

  test('a snapshot is a ref an ordinary git can see', async () => {
    const cwd = await repository();
    await writeFile(join(cwd, 'a.txt'), 'a');
    const snapshot = (await gitWorkspaceSnapshots().capture({
      workspace: cwd,
      runId: 'run-7',
      step: stubStep(3),
      signal: new AbortController().signal,
    }))!;

    const show = Bun.spawn(['git', 'show', '--name-only', '--format=%s', 'refs/pipelines/run-7/3'], {
      cwd,
      stdout: 'pipe',
    });
    const output = await new Response(show.stdout).text();
    expect(await show.exited).toBe(0);
    expect(output).toContain('run-7 3 step');
    expect(output).toContain('a.txt');
    expect(snapshot.split(':')[0]).toBeTruthy();
  });

  test('a workspace that is not a repository says so', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'not-a-repo-'));
    expect(
      gitWorkspaceSnapshots().capture({
        workspace: cwd,
        runId: 'run-id',
        step: stubStep(),
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/needs a git repository/);
  });
});

describe('a resumed run continues against the workspace it left behind', () => {
  test('replayed steps restore the tree they produced', async () => {
    const cwd = await repository();
    const snapshots = gitWorkspaceSnapshots();
    const ran: string[] = [];
    let shouldFail = true;

    const build = () =>
      definePipeline({
        name: 'workspace-resume',
        async run(ctx) {
          await ctx.step('write', async () => {
            ran.push('write');
            await writeFile(join(ctx.workspace, 'artifact.txt'), 'from the first run');
            return 'written';
          });
          const session = await ctx.claude({ name: 'think', prompt: 'think about it' });
          return await ctx.step('read-back', async () => {
            if (shouldFail) throw new Error('not yet');
            // Only passes if the file the replayed step wrote is actually there.
            return `${session.text}:${await Bun.file(join(ctx.workspace, 'artifact.txt')).text()}`;
          });
        },
      });

    const claude = fake({ think: 'thought' });
    const failed = await build().run({ input: undefined, workspace: cwd, claude, snapshots });
    expect(failed.status).toBe('failed');
    expect(failed.steps[0]!.snapshot).toBeTruthy();

    // The workspace is gone as far as this run is concerned: someone cleaned it, or the
    // recovery is happening on a fresh checkout.
    await rm(join(cwd, 'artifact.txt'));

    shouldFail = false;
    const resumed = await build().run({
      input: undefined,
      workspace: cwd,
      claude,
      snapshots,
      resumeFrom: failed,
    });

    expect(resumed.status).toBe('completed');
    expect(resumed.output).toBe('thought:from the first run');
    // The file came back from the snapshot, not from re-running the step.
    expect(ran).toEqual(['write']);
    expect(resumed.steps[0]!.replayed).toBe(true);
  });

  test('a run where everything replays still leaves the workspace as recorded', async () => {
    const cwd = await repository();
    const snapshots = gitWorkspaceSnapshots();

    const pipeline = definePipeline({
      name: 'all-replayed',
      async run(ctx) {
        return await ctx.step('write', async () => {
          await writeFile(join(ctx.workspace, 'artifact.txt'), 'recorded');
          return 'written';
        });
      },
    });

    const first = await pipeline.run({ input: undefined, workspace: cwd, snapshots });
    await rm(join(cwd, 'artifact.txt'));

    const again = await pipeline.run({ input: undefined, workspace: cwd, snapshots, resumeFrom: first });
    expect(again.status).toBe('completed');
    expect(again.steps[0]!.replayed).toBe(true);
    // Nothing needed the workspace during the run, so the restore was owed at the end.
    expect(await read(cwd, 'artifact.txt')).toBe('recorded');
  });

  test('the workspace is restored once, not once per replayed step', async () => {
    const cwd = await repository();
    const restores: number[] = [];
    const captured: string[] = [];
    const snapshots: WorkspaceSnapshots = {
      capture({ step }) {
        const id = `snap-${step.index}`;
        captured.push(id);
        return id;
      },
      restore({ snapshot }) {
        restores.push(Number(snapshot.split('-')[1]));
      },
    };

    let shouldFail = true;
    const build = () =>
      definePipeline({
        name: 'restore-once',
        async run(ctx) {
          await ctx.step('one', () => 1);
          await ctx.step('two', () => 2);
          await ctx.step('three', () => 3);
          return await ctx.step('four', () => {
            if (shouldFail) throw new Error('not yet');
            return 4;
          });
        },
      });

    const failed = await build().run({ input: undefined, workspace: cwd, snapshots });
    expect(failed.status).toBe('failed');
    expect(captured).toEqual(['snap-0', 'snap-1', 'snap-2']);

    shouldFail = false;
    const resumed = await build().run({
      input: undefined,
      workspace: cwd,
      snapshots,
      resumeFrom: failed,
    });

    expect(resumed.status).toBe('completed');
    // One restore, of the last replayed step's snapshot — not one per replayed step.
    expect(restores).toEqual([2]);
  });

  test('a snapshot that cannot be taken fails the step that could not be recorded', async () => {
    const cwd = await repository();
    const snapshots: WorkspaceSnapshots = {
      capture() {
        throw new Error('disk full');
      },
      restore() {},
    };

    const seen: string[] = [];
    const result = await definePipeline({
      name: 'uncapturable',
      run: (ctx) => ctx.step('work', () => 'value'),
    }).run({
      input: undefined,
      workspace: cwd,
      snapshots,
      on: { stepFinished: (s) => void seen.push(`${s.name}:${s.status}`) },
    });

    expect(result.status).toBe('failed');
    expect(result.error).toContain('disk full');
    // Recorded once, as failed — not as a completed step with no snapshot.
    expect(seen).toEqual(['work:failed']);
  });
});

describe('snapshots under adverse conditions', () => {
  test('a workspace inside a repository is refused, not half-captured', async () => {
    const cwd = await repository();
    await mkdir(join(cwd, 'sub'), { recursive: true });

    // `add -A .` is scoped to the directory it runs in and `read-tree --reset -u` is
    // not, so capturing here and restoring would delete everything above `sub`.
    expect(
      gitWorkspaceSnapshots().capture({
        workspace: join(cwd, 'sub'),
        runId: 'run-id',
        step: stubStep(),
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/top level/);
  });

  test('a snapshot survives a garbage collection', async () => {
    const cwd = await repository();
    const snapshots = gitWorkspaceSnapshots();
    const signal = new AbortController().signal;

    await writeFile(join(cwd, 'tracked.txt'), 'committed');
    for (const args of [['add', 'tracked.txt'], ['commit', '-q', '-m', 'first']]) {
      expect(await Bun.spawn(['git', ...args], { cwd, stdout: 'ignore', stderr: 'ignore' }).exited).toBe(0);
    }
    // An index that differs from the working tree, so the staged tree is its own object.
    await writeFile(join(cwd, 'staged.txt'), 'staged');
    expect(await Bun.spawn(['git', 'add', 'staged.txt'], { cwd, stdout: 'ignore' }).exited).toBe(0);
    await writeFile(join(cwd, 'loose.txt'), 'loose');

    const snapshot = (await snapshots.capture({ workspace: cwd, runId: 'run-id', step: stubStep(), signal }))!;

    const gc = Bun.spawn(['git', 'gc', '--prune=now', '--quiet'], { cwd, stdout: 'ignore', stderr: 'pipe' });
    expect(await gc.exited).toBe(0);

    await rm(join(cwd, 'loose.txt'));
    await snapshots.restore({ workspace: cwd, runId: 'run-id', step: stubStep(), snapshot, signal });
    expect(await read(cwd, 'loose.txt')).toBe('loose');
    expect(await status(cwd)).toContain('A  staged.txt');
  });

  test('a concurrent group waits for the restore, all of it', async () => {
    const cwd = await repository();
    const marker = join(cwd, 'restored');
    const snapshots: WorkspaceSnapshots = {
      capture: () => 'snap',
      // Slow, and the marker appears only at the end: a command that starts before the
      // restore finishes sees a tree mid-rewrite, and here says so by failing.
      restore: async () => {
        await Bun.sleep(60);
        await writeFile(marker, 'yes');
      },
    };

    const build = (stop: boolean) =>
      definePipeline({
        name: 'group-restore',
        async run(ctx) {
          await ctx.step('seed', () => 'seeded');
          if (stop) ctx.halt('nothing more this time');
          const handles = await ctx.commands([
            { name: 'a', command: 'test -f restored' },
            { name: 'b', command: 'test -f restored' },
            { name: 'c', command: 'test -f restored' },
          ]);
          return handles.map((handle) => handle.exitCode);
        },
      });

    const first = await build(true).run({ input: undefined, workspace: cwd, snapshots });
    expect(first.status).toBe('halted');

    const resumed = await build(false).run({
      input: undefined,
      workspace: cwd,
      snapshots,
      resumeFrom: first,
    });

    expect(resumed.status).toBe('completed');
    expect(resumed.output).toEqual([0, 0, 0]);
  });

  test('a halted run whose restore fails keeps the record of having halted', async () => {
    const cwd = await repository();
    const snapshots: WorkspaceSnapshots = {
      capture: () => 'snap',
      restore: () => {
        throw new Error('the snapshot is gone');
      },
    };

    const pipeline = definePipeline({
      name: 'halt-then-fail',
      steps: ['seed', 'never'],
      async run(ctx) {
        await ctx.step('seed', () => 'seeded');
        ctx.halt('everything already done');
      },
    });

    const first = await pipeline.run({ input: undefined, workspace: cwd, snapshots });
    expect(first.status).toBe('halted');

    // Everything replays, so the restore is owed at the end — and it fails there.
    const resumed = await pipeline.run({
      input: undefined,
      workspace: cwd,
      snapshots,
      resumeFrom: first,
    });

    expect(resumed.status).toBe('failed');
    expect(resumed.error).toContain('the snapshot is gone');
    // The run did halt, and the record still says so and still names what it skipped.
    expect(resumed.haltReason).toBe('everything already done');
    expect(resumed.steps.find((step) => step.name === 'never')!.status).toBe('skipped');
  });
});
