import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { definePipeline } from '../src/index.ts';

/**
 * The one test that opens a real session. Gated so the default `bun test` needs no
 * subscription: run it with `RUN_E2E=1 bun test tests/e2e.test.ts`.
 */
const enabled = process.env.RUN_E2E === '1';

describe.skipIf(!enabled)('end to end against a real Claude session', () => {
  test(
    'a Claude step reads the workspace and returns a validated Output',
    async () => {
      const workspace = mkdtempSync(join(tmpdir(), 'pipelines-e2e-'));
      writeFileSync(join(workspace, 'VERSION.txt'), '7.3.1\n');

      const pipeline = definePipeline({
        name: 'e2e-read-version',
        steps: ['read-version', 'confirm'],
        async run(ctx) {
          const read = await ctx.claude({
            name: 'read-version',
            prompt:
              'Read VERSION.txt in the current directory and report the version string it ' +
              'contains, exactly as written, with no surrounding whitespace.',
            output: z.object({ version: z.string() }),
            retry: 1,
          });

          if (read.output.version !== '7.3.1') {
            ctx.halt(`unexpected version ${read.output.version}`);
          }

          const check = await ctx.command({ name: 'confirm', command: 'cat VERSION.txt' });
          return { version: read.output.version, onDisk: check.stdout.trim() };
        },
      });

      const result = await pipeline.run({ input: undefined, workspace });

      expect(result.error).toBeUndefined();
      expect(result.status).toBe('completed');
      expect(result.output).toEqual({ version: '7.3.1', onDisk: '7.3.1' });
      expect(result.steps[0]!.sessionId).toBeString();
    },
    { timeout: 300_000 },
  );
});
