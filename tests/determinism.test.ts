import { describe, expect, test } from 'bun:test';
import { definePipeline, fake } from '../src/index.ts';

describe('recorded values', () => {
  test('the clock, randomness and ids are read once and replayed after', async () => {
    const pipeline = definePipeline({
      name: 'recorded',
      async run(ctx) {
        return {
          at: await ctx.now(),
          roll: await ctx.random(),
          id: await ctx.uuid(),
        };
      },
    });

    const first = await pipeline.run({ input: undefined });
    await Bun.sleep(2);
    const second = await pipeline.run({ input: undefined, resumeFrom: first });

    expect(second.output).toEqual(first.output);
    expect(second.steps.every((s) => s.replayed === true)).toBe(true);

    // A run that is not resuming reads them afresh.
    const third = await pipeline.run({ input: undefined });
    expect(third.output).not.toEqual(first.output);
  });

  test('they are recorded as steps, named by position across all three', async () => {
    const result = await definePipeline({
      name: 'positions',
      async run(ctx) {
        await ctx.now();
        await ctx.uuid();
        await ctx.now();
        await ctx.random();
      },
    }).run({ input: undefined });

    expect(result.steps.map((s) => s.name)).toEqual(['now#1', 'uuid#2', 'now#3', 'random#4']);
    expect(result.steps.every((s) => s.kind === 'value')).toBe(true);
    expect(result.steps.every((s) => s.status === 'completed')).toBe(true);
  });

  test('a recorded clock keeps the steps below it replayable', async () => {
    const ran: string[] = [];
    const build = () =>
      definePipeline({
        name: 'stable-chain',
        async run(ctx) {
          const at = await ctx.now();
          const said = await ctx.claude({ name: 'think', prompt: 'think' });
          await ctx.step('use', () => {
            ran.push('use');
            return `${said.finalMessage}@${at}`;
          });
        },
      });

    const claude = fake({ think: 'thought' });
    const first = await build().run({ input: undefined, claude });
    await Bun.sleep(2);
    const resumed = await build().run({ input: undefined, claude, resumeFrom: first });

    expect(resumed.status).toBe('completed');
    // The session and the effect below the clock both replayed: the clock did not move
    // under them, which is the whole reason to read it through a step.
    expect(claude.calls).toHaveLength(1);
    expect(ran).toEqual(['use']);
    expect(resumed.steps.every((s) => s.replayed === true)).toBe(true);
  });

  test('a driver-read value that reaches a step re-runs everything below it', async () => {
    const ran: string[] = [];
    const build = () =>
      definePipeline({
        name: 'leaked-into-declaration',
        async run(ctx) {
          // Read in the driver and put into the step's own declaration.
          const stamp = await ctx.command({ name: 'stamp', command: `echo ${Date.now()}` });
          await ctx.step('use', () => {
            ran.push('use');
            return stamp.stdout.trim();
          });
        },
      });

    const first = await build().run({ input: undefined });
    await Bun.sleep(2);
    const resumed = await build().run({ input: undefined, resumeFrom: first });

    // The clock changed the step's identity, so it re-ran — and its Output changed,
    // which broke the chain for the step below it too. Nothing about the work differed.
    expect(resumed.steps.map((s) => s.replayed)).toEqual([undefined, undefined]);
    expect(ran).toEqual(['use', 'use']);
  });

  test('a driver-read value that only hides in a closure is silently discarded', async () => {
    const build = () =>
      definePipeline({
        name: 'hidden-in-closure',
        async run(ctx) {
          const at = Date.now();
          return await ctx.step('use', () => `at:${at}`);
        },
      });

    const first = await build().run({ input: undefined });
    await Bun.sleep(2);
    const resumed = await build().run({ input: undefined, resumeFrom: first });

    // The other half of the hazard: a code step's identity is its source, and a captured
    // value is invisible to that (ADR 0008). So the step replays, and the value the
    // driver just read is thrown away without anyone noticing.
    expect(resumed.steps[0]!.replayed).toBe(true);
    expect(resumed.output).toBe(first.output);
  });

  test('a value step is never snapshotted, and does not disturb the chain', async () => {
    const captured: string[] = [];
    const snapshots = {
      capture: ({ step }: { step: { name: string } }) => {
        captured.push(step.name);
        return `snap-${step.name}`;
      },
      restore: () => {},
    };

    const result = await definePipeline({
      name: 'value-snapshots',
      async run(ctx) {
        await ctx.step('work', () => 'a');
        await ctx.now();
      },
    }).run({ input: undefined, snapshots });

    expect(result.status).toBe('completed');
    // The workspace cannot have changed, so there is nothing to capture.
    expect(captured).toEqual(['work']);
    expect(result.steps[1]!.snapshot).toBeUndefined();
  });
});
