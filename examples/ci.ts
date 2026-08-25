/**
 * The pipeline from the original sketch: install once, fan out the checks,
 * then deploy. Run it with `bun run examples/ci.ts`.
 *
 * Nothing here is a graph definition — `await` is the edge. `install` is awaited
 * before the checks are created, so the checks depend on it; the four checks are
 * created together inside `Promise.all`, so they run together.
 */
import { definePipeline, inputType, toMermaid } from '../src/index.ts';

const ci = definePipeline({
  name: 'ci',
  input: inputType<{ deploy: boolean }>(),
  concurrency: { exec: 4 },
  reporter: true,
  run: async (ctx) => {
    const deps = await ctx.exec({
      name: 'install',
      command: 'bun install --frozen-lockfile',
      // Declaring the inputs is what makes this node skippable: while the
      // manifest and lockfile are byte-identical, the result is replayed.
      cache: { inputs: ['package.json', 'bun.lock'] },
    });

    // Every check hangs off `deps`, so a re-install invalidates all of them.
    await Promise.all([
      deps.exec({ name: 'lint', command: 'bun run lint', allowFailure: true }),
      deps.exec({ name: 'test', command: 'bun test' }),
      deps.exec({ name: 'typecheck', command: 'bun run typecheck' }),
      deps.exec({ name: 'build', command: 'bun run build', allowFailure: true }),
    ]);

    if (ctx.input.deploy) {
      await deps.exec({
        name: 'deploy',
        command: 'bun wrangler deploy',
        env: { CLOUDFLARE_ACCOUNT_ID: process.env.CLOUDFLARE_DEPLOY_ACCOUNT_ID },
        retry: { attempts: 3, backoffMs: 2000 },
        timeout: 5 * 60_000,
      });
    }
  },
});

const run = await ci.run({ deploy: false });
console.log(toMermaid(run.graph));
