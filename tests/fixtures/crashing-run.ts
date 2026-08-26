/**
 * Runs `crashingPipeline` and kills its own process in the middle of the `ship` step,
 * with no chance to record anything about it. Spawned by the durability tests: an
 * in-process test can simulate a crash, but only a real SIGKILL proves the journal on
 * disk is enough on its own.
 *
 * RUN_DB, WORKSPACE, RUN_ID and CRASH_MODE come from the test.
 */
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { sqliteStorage } from '../../src/index.ts';
import { crashingClaude, crashingPipeline } from './crashing-pipeline.ts';

const workspace = process.env.WORKSPACE!;
const effects = join(workspace, 'shipped.log');
// 'after' kills once the effect has landed but before anything could record that it
// did — the case a reconcile exists for. 'before' kills on the way in.
const afterEffect = process.env.CRASH_MODE === 'after';

const storage = sqliteStorage({ path: process.env.RUN_DB! });

await crashingPipeline({
  async ship() {
    if (afterEffect) appendFileSync(effects, 'shipped\n');
    process.kill(process.pid, 'SIGKILL');
    // Unreachable in practice; keeps the step from resolving if the signal is slow.
    return await new Promise<string>(() => {});
  },
}).run({
  input: { marker: 'm1' },
  workspace,
  runId: process.env.RUN_ID,
  storage,
  claude: crashingClaude(),
});
