# @marcoripa96/claude-code-pipelines-sdk

Deterministic pipelines whose steps are Claude Code sessions, shell commands, or
ordinary code. The pipeline's shape is always decided by code; Claude only ever
supplies values that code branches on.

> **Claude acts on the workspace. Code acts on everything outside it.**
>
> Editing files, running tests and grepping are Claude's own business, and the
> pipeline does not mediate them. Labels, comments, status changes and pull requests
> are External effects: pipeline code performs them, from a step's Output, where they
> are visible in the run record and testable with a fixture. Claude never selects what
> runs next.

## Install

Requires [bun](https://bun.com) — the default storage adapter is `bun:sqlite` and
command steps run on `Bun.$` (ADR 0005). `zod` v4 is a peer dependency.

```sh
bun add @marcoripa96/claude-code-pipelines-sdk zod
```

## A minimal pipeline

```ts
import { definePipeline } from '@marcoripa96/claude-code-pipelines-sdk';
import { z } from 'zod';

export const triage = definePipeline({
  name: 'triage',
  input: z.object({ issueId: z.number() }),
  steps: ['classify', 'apply-labels', 'implement'],

  async run(ctx) {
    const classify = await ctx.claude({
      name: 'classify',
      prompt: `Classify issue ${ctx.input.issueId}.`,
      output: z.object({
        type: z.enum(['bug', 'feature', 'chore']),
        labels: z.array(z.string()),
      }),
    });

    // An External effect, performed by code from the Output.
    await ctx.step('apply-labels', () =>
      tracker.addLabels(ctx.input.issueId, classify.output.labels),
    );

    // The branch is here, in TypeScript, on a value.
    if (classify.output.type === 'chore') ctx.halt('chores are not implemented here');

    await ctx.claude({ name: 'implement', prompt: 'Implement it.' });
    await ctx.command({ name: 'test', command: 'bun test' });
  },
});

const result = await triage.run({
  input: { issueId: 42 },
  workspace: '/checkouts/acme-web',
});
```

`run()` resolves to a `RunResult` rather than throwing: check `result.status`, which is
`completed`, `halted` or `failed`. A halt is a success — `result.haltReason` says why,
and steps the run never reached are recorded as `skipped`. A failure carries
`result.error` (and the original error on `result.cause`).

[`examples/kanby-software-factory/`](examples/kanby-software-factory/) is a worked design
against an ideal Kanby v2 CLI: one pipeline detects where a task is on the board and runs
exactly the stages it still needs — classify and analyze `backlog` intake into an
implementation-ready brief, or deliver a prepared `todo` through checks, review and a
self-hosted GitLab merge request opened with GitBeaker.

```sh
bun run examples/kanby-software-factory/index.ts --real
```

## Step kinds

| | declares | returns |
|---|---|---|
| `ctx.claude(...)` | `prompt`, optional `output` schema, `retry`, `model`, `cwd`, `cache`, `timeout` | handle with `.output` (schema) or `.text` (no schema) |
| `ctx.command(...)` | `command`, `allowFailure`, `cwd`, `env`, `cache`, `timeout` | handle with `.stdout`, `.stderr`, `.exitCode`; throws on a non-zero exit unless allowed |
| `ctx.commands([...])` | a group of command steps, optional `concurrency` | their handles, in the order declared |
| `ctx.step(name, fn)` | a function, optional `{ timeout }` | whatever the function returns |
| `ctx.halt(reason)` | a reason | `never` — the run ends, successfully |

Steps execute sequentially, except a group handed to `ctx.commands()` (ADR 0004).
Context crosses between steps as interpolated Output values or as data a step re-reads;
a Claude session is always fresh and never inherits another step's conversation.

### Deadlines

Any step may declare `timeout`, in milliseconds. It is enforced by the runner rather
than by each kind, so it means the same thing everywhere: a command step's process is
killed, a Claude session is aborted, and a code step that never looks at the signal it
was handed still fails on time.

```ts
await ctx.command({ name: 'test', command: 'bun test', timeout: 5 * 60_000 });
await ctx.step('poll', (signal) => fetch(url, { signal }), { timeout: 10_000 });
```

A deadline is not part of a cache key: how long a step was allowed to take does not
change what it produced.

### Running commands together

```ts
const [lint, test, types] = await ctx.commands([
  { name: 'lint', command: 'bun run lint' },
  { name: 'test', command: 'bun test' },
  { name: 'typecheck', command: 'tsc --noEmit' },
], { concurrency: 2 });   // omit to run them all at once
```

Command steps only — concurrent Claude steps would race on one workspace, which is why
ADR 0004 made runs sequential in the first place. A group is recorded in the order it
was written, every member is keyed against the same upstream snapshot, and if one fails
its siblings still finish and are recorded before the group throws.

### Claude steps

Each is one `query()` against `@anthropic-ai/claude-agent-sdk`. Declaring `output`
turns the answer into a schema-validated Output using the SDK's own `outputFormat`
(ADR 0002); the SDK's structured-output retries happen inside a step, and `retry: n`
adds `n` further whole-session attempts around them.

The defaults are `permissionMode: 'bypassPermissions'` (an unattended pipeline that
stops to ask a human is a hang, not a safeguard), `skills: 'all'` so the prompt can name
the skill it wants, `settingSources: ['project']` so `CLAUDE.md` and project skills load,
and `cwd` from the run's workspace unless the step overrides it.

## Run options

```ts
await pipeline.run({
  input,                 // validated against the pipeline's input schema
  workspace,             // the directory this run operates in; defaults to process.cwd()
  model,                 // default model for Claude steps, and part of every cache key
  storage: sqliteStorage('.pipelines/runs.sqlite'),
  cache: sqliteCache('.pipelines/cache.sqlite'),
  claude: fake({ ... }), // fixture Outputs instead of real sessions
  signal,                // an AbortSignal
  resumeFrom: previous,  // a previous RunResult, or a run id; unchanged steps replay
  snapshots: gitWorkspaceSnapshots(),  // restore the workspace a replayed step left behind
  heartbeatMs: 15_000,   // how often to renew this run's lease
  on: {
    runStarted:  (run)  => {},
    stepStarted: (step) => {},
    message:     (m, step) => {},   // Claude's SDKMessage, verbatim
    stepFinished:(step) => {},
    runFinished: (run)  => {},
    error:       (e)    => {},      // a listener that threw; never fails the run
  },
});
```

The workspace is per run, because the thing a pipeline works on may be a different
checkout each time.

### Resuming a failed run

```ts
const first = await pipeline.run({ input });
if (first.status === 'failed') {
  await pipeline.run({ input, resumeFrom: first });
}
```

Every step whose work is unchanged replays the earlier run's result, so a failure in
step nine costs step nine and not the eight sessions before it. Code steps replay too,
which is the point: a resumed run must not post the comment twice.

A step replays when its **fingerprint** matches a completed step of the earlier run —
the same value ADR 0006 defines as a cache key, computed for every step. Because it
covers the Outputs above a step, a step that genuinely produces something different
invalidates everything below it, while one that re-runs and produces the same Output
leaves them replayable.

Pass the `RunResult` you were given, or a run id for a store that can read one back.

### Surviving a crash

Resuming handles a failure. A run whose *process* dies is a different problem: its steps
stop mid-flight, nobody holds its record, and nothing says it stopped. Durability closes
that (ADR 0009), and recovery is one call:

```ts
const abandoned = storage.resumable({ pipeline: 'ship-it', staleMs: 60_000 });
for (const run of abandoned) {
  await pipeline.recover({ runId: run.id, storage });
}
```

`recover()` reads the run's input, workspace and model back from its own record, replays
what completed, and finishes the rest. The run it takes over is marked `superseded`, so it
is not offered twice — and the marking is exclusive: two supervisors that both saw the
same abandoned run do not both finish it, because the one that loses the claim stops with
`RunTakenError` before any step runs.

**A step a crash interrupted is indeterminate** — its work may have landed, may not have.
Replaying it would be a lie and redoing it would be a duplicate merge request, so a code
step stops and says so. Tell it how to find out instead:

```ts
await ctx.step('open-merge-request', (signal) => gitlab.open(dest, signal), {
  // Asked only on a recovered run: a value means it already happened and is adopted.
  reconcile: (signal) => gitlab.find(dest.sourceBranch, signal),
});

await ctx.step('post-comment', (signal) => post(signal), { onCrash: 'rerun' });
```

Claude and command steps default to `onCrash: 'rerun'` — they act on the workspace, which
snapshots restore, so repeating one costs tokens rather than correctness. `ctx.step`
defaults to `'fail'`, because it is where External effects live.

**Replay restores Outputs, not files.** A replayed session hands back the Output it
produced, not the forty files it edited. Give the run a `WorkspaceSnapshots` adapter and
the tree comes back too:

```ts
await pipeline.run({ input, snapshots: gitWorkspaceSnapshots() });
```

The Git implementation captures the working tree *and* the index after each step, through
a scratch index file so your own index is never touched, and keeps each one behind
`refs/pipelines/<runId>/<step>` where ordinary Git can see it (and where `git gc` will not
take it). The workspace must be the repository's top level, since restoring rewrites the
whole tree. On a resumed run nothing is
restored while steps replay; the tree is put back once, at the first step that must do
real work (ADR 0011).

**The code between steps runs again.** Resuming re-executes the pipeline function from the
top, so anything the driver reads for itself must come from a step — otherwise it either
changes the fingerprint of every step below it, or hides in a closure and is silently
discarded on replay. The three that are too easy to get wrong are supplied (ADR 0010):

```ts
const at = await ctx.now();      // Date.now(), recorded and replayed
const roll = await ctx.random();
const id = await ctx.uuid();
```

### Storage

`StorageAdapter` is a sink for a run's history: `runStarted`, `stepStarted`,
`messageAppended`, `stepFinished`, `runFinished`. The SDK never deletes anything —
retention belongs to whoever implements it. Four further methods are optional, and are
what make a run recoverable rather than merely recorded: `readRun`, `resumable`,
`heartbeat` and `runSuperseded` (ADR 0009). An adapter implementing all of them is a
`RunStore`, which is what `pipeline.recover()` asks for. If you already have a
database, implement the adapter against it rather than running a second store beside it
(ADR 0003); the default `sqliteStorage()` keeps `runs`, `steps` and `messages` tables in
a `bun:sqlite` file, which you then query with your own SQL.

One adapter serves any number of runs, and the SDK never closes the database — it does
not know when you are finished with it, so call `storage.db.close()` yourself. A run id
must be unique: pass your own `runId` and a duplicate is reported rather than merged
into the existing row.

Storage is history, not the live view. Live progress comes from `on`, because the
application watching a run is the process running it.

### Caching

Steps are never cacheable by default. A step opts in, and the run supplies an adapter:

```ts
await ctx.claude({ name: 'analyze', prompt, output, cache: { inputs: ['package.json', 'src/**'] } });
```

`inputs` takes file paths, glob patterns, or a directory, which is read as everything
beneath it. The key hashes the step's configuration, the contents of its declared input
files, the pipeline's input, every upstream step's Output, and the model name. That deliberately
over-invalidates (ADR 0006): re-running costs a session, while a silently stale hit costs
an afternoon. `memoryCache()` and `sqliteCache()` are included; `CacheAdapter` is two
methods if you want your own.

## Testing pipelines

Branch logic is the thing worth testing, and `fake()` makes it testable with no API call:

```ts
import { fake } from '@marcoripa96/claude-code-pipelines-sdk';

const result = await triage.run({
  input: { issueId: 42 },
  claude: fake({
    classify: { type: 'chore', labels: ['chore'] },   // a plain object is the Output
    analyze: [new Error('session died'), { viable: true }],  // one entry per attempt
    summarise: 'plain text, for a step with no schema',
  }),
});

expect(result.status).toBe('halted');
expect(result.steps.find((s) => s.name === 'implement')?.status).toBe('skipped');
```

Fixtures still go through the step's Output schema, so one that would not have validated
fails the step exactly as a real answer would. `session({ output, text, sessionId,
messages })` spells out a stand-in session when the Output alone is not enough, and the
returned runner records every request on `.calls`.

```sh
bun test              # no session, no subscription needed
RUN_E2E=1 bun test tests/e2e.test.ts   # the one test that opens a real session
```

## Design

`CONTEXT.md` is the glossary, `docs/design.md` the API shape, and `docs/adr/` the
decisions and why:

| | |
|---|---|
| [0001](docs/adr/0001-code-owns-control-flow.md) | Code owns control flow; Claude only supplies values |
| [0002](docs/adr/0002-native-output-format.md) | Use the Agent SDK's native `outputFormat` for step Outputs |
| [0003](docs/adr/0003-pluggable-storage.md) | Storage is a pluggable adapter, with `bun:sqlite` as the default |
| [0004](docs/adr/0004-sequential-execution.md) | Runs are sequential by default, and command steps may fan out |
| [0005](docs/adr/0005-bun-only.md) | The SDK targets bun, not Node |
| [0006](docs/adr/0006-conservative-cache-keys.md) | Cache keys deliberately over-invalidate |
| [0007](docs/adr/0007-declared-step-names-for-skipped.md) | Skipped steps come from an optional declared step list |
| [0008](docs/adr/0008-resume-from-a-run-record.md) | Resume takes the previous run's record, not a read from storage |
| [0009](docs/adr/0009-durable-runs.md) | A run survives the death of the process that started it |
| [0010](docs/adr/0010-determinism-in-the-driver.md) | Non-determinism belongs in a step, and the SDK supplies the common cases |
| [0011](docs/adr/0011-workspace-snapshots.md) | Replay restores Outputs; snapshots restore the workspace |

## Licence

MIT.
