import { z } from 'zod';
import { definePipeline, fake } from '../../src/index.ts';
import type { CrashPolicy, FakeRunner } from '../../src/index.ts';

export interface CrashingHooks {
  /** The effectful step. In the crashing process this one never returns. */
  ship(signal: AbortSignal): Promise<string>;
  reconcile?(signal: AbortSignal): Promise<string | undefined>;
  onCrash?: CrashPolicy;
}

/**
 * The pipeline both halves of a crash test run: the process that dies holding it, and
 * the process that picks it up.
 *
 * Shared deliberately. A code step's fingerprint covers its source (ADR 0008), so two
 * hand-written copies of "the same" pipeline would not recognise each other's steps —
 * which is exactly the property under test, and not something a test should fake around.
 * The hooks are captured values, invisible to `fn.toString()`, so both processes produce
 * the identical source.
 */
export function crashingPipeline(hooks: CrashingHooks) {
  return definePipeline({
    name: 'crashing',
    input: z.object({ marker: z.string() }),
    steps: ['prepare', 'classify', 'ship'],
    async run(ctx) {
      const prepared = await ctx.step('prepare', () => 'ready');
      const verdict = await ctx.claude({
        name: 'classify',
        prompt: 'classify the work',
        output: z.object({ label: z.string() }),
      });
      const shipped = await ctx.step('ship', (signal) => hooks.ship(signal), {
        reconcile: hooks.reconcile,
        onCrash: hooks.onCrash,
      });
      return `${prepared}:${verdict.output.label}:${shipped}`;
    },
  });
}

/** The same stand-in session on both sides, so a replayed step matches a real one. */
export function crashingClaude(): FakeRunner {
  return fake({ classify: { label: 'bug' } });
}
