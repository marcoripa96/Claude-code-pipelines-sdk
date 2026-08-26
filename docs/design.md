# Design

The shape agreed during the design interview, as implemented. Where the implementation
learned something the interview could not, this file says so.

## The rule

> Claude acts on the workspace. Code acts on everything outside it.

Claude edits files, runs tests and greps — that is its job and the pipeline does not
mediate it. Labels, comments, status changes and pull requests are External effects,
performed by pipeline code from a step's Output, where they are visible in the run
record and testable with a fixture.

## Defining and running

```ts
import { definePipeline } from '@marcoripa96/claude-code-pipelines-sdk';
import { z } from 'zod';

export const implementIssue = definePipeline({
  name: 'implement-issue',
  input: z.object({ issueId: z.number() }),
  async run(ctx) {
    const classify = await ctx.claude({
      name: 'classify',
      prompt: `Classify issue ${ctx.input.issueId}. /classify-issue`,
      output: z.object({
        type: z.enum(['bug', 'feature', 'chore']),
        labels: z.array(z.string()),
      }),
    });

    await ctx.step('apply-labels', () =>
      tracker.addLabels(ctx.input.issueId, classify.output.labels),
    );

    const analysis = await ctx.claude({
      name: 'analyze',
      prompt: 'Analyse feasibility and produce a plan.',
      output: z.object({
        viable: z.boolean(),
        reason: z.string(),
        plan: z.string(),
      }),
      retry: 2,
    });

    if (!analysis.output.viable) {
      await ctx.step('block', () => tracker.block(ctx.input.issueId, analysis.output.reason));
      ctx.halt('not viable');            // typed `never`; nothing below runs
    }

    const impl = await ctx.claude({
      name: 'implement',
      prompt: `Implement this plan:\n${analysis.output.plan}`,
      output: z.object({ summary: z.string() }),
    });

    await ctx.command({ name: 'test', command: 'bun test' });
  },
});

const run = implementIssue.run({
  input: { issueId: 42 },
  workspace: '/checkouts/acme-web',
  on: {
    stepStarted: (s) => console.log('▶', s.name),
    message: (m) => inspector.push(m),   // raw SDKMessage, verbatim
    stepFinished: (s) => console.log('✔', s.name, s.durationMs),
  },
});
```

Context crosses between steps as interpolated Output values or as data a step re-reads.
Sessions are always fresh: a Claude step never inherits another step's conversation.

## Step kinds

| | declares | returns |
|---|---|---|
| `ctx.claude(...)` | `prompt`, optional `output` schema, `retry`, `model`, `cwd`, `cache`, `timeout` | handle with `.output` (schema) or `.text` (no schema) |
| `ctx.command(...)` | `command`, `allowFailure`, `cache`, `timeout` | handle with `.stdout`, `.stderr`, `.exitCode`; throws on non-zero unless allowed |
| `ctx.commands([...])` | a group of command steps, optional `concurrency` | their handles, in declaration order |
| `ctx.step(name, fn)` | a function, optional `{ timeout, onCrash, reconcile }` | whatever the function returns |
| `ctx.now()` / `ctx.random()` / `ctx.uuid()` | nothing | a recorded value that replays (ADR 0010) |

Command steps are spawned as `sh -c`, not run through `Bun.$`: a step's `timeout` has to
be able to kill the process, and `$` exposes no way to cancel one.

Steps execute sequentially, except a group handed to `ctx.commands()` (ADR 0004), whose
`concurrency` is a bound of at least one or `Infinity` for unbounded — zero is refused
rather than read as "all at once". Every step may declare a `timeout`, enforced by the
runner so it bounds all three kinds alike.

`definePipeline` takes `defaults` for the step options a pipeline sets once rather than at
every call site. Today that is `onCrash`, because a pipeline whose effects are uniformly
repeatable is stating a property of itself; a step that disagrees still overrides it.

## Claude sessions

Each `claude()` step is one `query()` against `@anthropic-ai/claude-agent-sdk`:

- `outputFormat: { type: 'json_schema', schema: z.toJSONSchema(output) }` when a schema is
  declared, read back off the result's `structured_output`. The `$schema` key Zod emits is
  removed first: the CLI validates the schema with a resolver that does not know the
  2020-12 meta-schema by URL and rejects it outright.
- `settingSources: ['project']` so `CLAUDE.md` and project skills load
- `skills: 'all'` — skills are simply available, and the prompt says which to use
  (`/classify-issue`), matching how Claude Code is used interactively
- `permissionMode: 'bypassPermissions'` by default, because an unattended pipeline that
  stops to ask a human is a hang rather than a safeguard
- `cwd` from the run's workspace, or the step's override

`retry: n` re-runs the whole step on session errors and non-zero exits. The SDK runs its
own structured-output retries inside that.

## Adapters

```ts
interface StorageAdapter {
  runStarted(run: RunRecord): Promise<void>;
  stepStarted(step: StepRecord): Promise<void>;
  messageAppended(stepId: string, message: SDKMessage): Promise<void>;
  stepFinished(step: StepRecord): Promise<void>;
  runFinished(run: RunRecord): Promise<void>;

  // Optional, and what makes a run recoverable rather than merely recorded (ADR 0009).
  readRun?(runId: string): Promise<RunResult | undefined>;
  resumable?(query?: ResumableQuery): Promise<RunRecord[]>;
  heartbeat?(runId: string, at: number): Promise<void>;
  runSuperseded?(previous: string, by: string): Promise<void>;
}

interface CacheAdapter {
  get(key: string): Promise<unknown | undefined>;
  set(key: string, value: unknown): Promise<void>;
}

interface WorkspaceSnapshots {
  capture(context: SnapshotContext): Promise<string | undefined>;
  restore(context: SnapshotContext & { snapshot: string }): Promise<void>;
}
```

Storage never deletes; retention belongs to whoever implements it. The required half is
write-only, and reads are the consumer's own SQL against their own database — the optional
half exists because a run nobody can load cannot be recovered by anyone but the process
that died holding it. An adapter implementing all four is a `RunStore`. The default
adapter is `bun:sqlite`, one table for runs, one for steps, one for messages.

Live progress does not come from storage. Because this is a library, the application
watching a run is the process running it, so it subscribes to `on` events: lifecycle
events we define, and Claude's `SDKMessage` passed through verbatim.

## Caching

Opt-in only, per step, via `cache: { inputs: ['package.json'] }`. The key hashes step
config, declared input file contents, pipeline input, upstream Outputs and the model
name — see ADR 0006.

## Resuming

```ts
const first = await implementIssue.run({ input: { issueId: 42 } });
if (first.status === 'failed') {
  await implementIssue.run({ input: { issueId: 42 }, resumeFrom: first });
}
```

Every step whose work is unchanged replays the earlier run's result rather than doing it
again — code steps included, so a resumed run does not repeat their External effects. The
match is on a step's **fingerprint**, the same value caching uses as its key but computed
for every step; because it covers the Outputs above a step, a changed Output invalidates
everything below it. The SDK never reads storage to find the earlier run: you pass the
record you were given, a run id for a store that can read one back, or one you rebuilt
with your own query. See ADR 0008.

## Recovering a run whose process died

```ts
for (const run of await storage.resumable({ pipeline: 'implement-issue', staleMs: 60_000 })) {
  await implementIssue.recover({ runId: run.id, storage });
}
```

Three things make this work, and each is an ADR:

- **The journal records intent** (0009). A step's fingerprint is written when it starts,
  not when it finishes, so a step a crash interrupted is identifiable rather than an
  anonymous `running` row a later run would silently redo. Such a step is *indeterminate*:
  a code step stops and says so unless it declares `reconcile` (ask the outside world
  whether the effect landed) or `onCrash: 'rerun'`. Claude and command steps re-run by
  default. A run's `heartbeat` is its lease; gone quiet means its work may be taken.
- **Non-determinism belongs in a step** (0010). Resuming re-executes the driver, so
  `ctx.now()`, `ctx.random()` and `ctx.uuid()` record their answers as steps. A value the
  driver reads for itself either re-runs every step below it or is silently discarded on
  replay, depending on whether it reaches a step's declaration.
- **Snapshots restore the workspace** (0011). A run resumed without the adapter that
  captured its snapshots stops with `WorkspaceUnrestorableError`, rather than replaying
  Outputs onto a tree it never put back. Replay restores Outputs, not the files a
  session edited. `gitWorkspaceSnapshots()` captures the working tree and the index after
  each step behind `refs/pipelines/<runId>/<step>`, and a resumed run puts the tree back
  once, at the first step that must do real work.

## Testing

`run({ input, claude: fake({ classify: { type: 'bug', labels: ['bug'] } }) })` substitutes
fixture Outputs for real sessions, so branch logic is testable with no API calls. This is
what the control-flow rule in ADR 0001 buys.
