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

`examples/implement-issue.ts` is the full worked pipeline —
classify → analyze → implement → review — runnable with fixture Outputs:

```sh
bun run examples/implement-issue.ts
```

## Step kinds

| | declares | returns |
|---|---|---|
| `ctx.claude(...)` | `prompt`, optional `output` schema, `retry`, `model`, `cwd`, `cache` | handle with `.output` (schema) or `.text` (no schema) |
| `ctx.command(...)` | `command`, `allowFailure`, `cwd`, `env`, `cache` | handle with `.stdout`, `.stderr`, `.exitCode`; throws on a non-zero exit unless allowed |
| `ctx.step(name, fn)` | a function | whatever the function returns |
| `ctx.halt(reason)` | a reason | `never` — the run ends, successfully |

Steps execute sequentially (ADR 0004). Context crosses between steps as interpolated
Output values or as data a step re-reads; a Claude session is always fresh and never
inherits another step's conversation.

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

### Storage

`StorageAdapter` is a write-only sink for a run's history: `runStarted`, `stepStarted`,
`messageAppended`, `stepFinished`, `runFinished`. It never reads, and the SDK never
deletes anything — retention belongs to whoever implements it. If you already have a
database, implement the adapter against it rather than running a second store beside it
(ADR 0003); the default `sqliteStorage()` keeps `runs`, `steps` and `messages` tables in
a `bun:sqlite` file, which you then query with your own SQL.

Storage is history, not the live view. Live progress comes from `on`, because the
application watching a run is the process running it.

### Caching

Steps are never cacheable by default. A step opts in, and the run supplies an adapter:

```ts
await ctx.claude({ name: 'analyze', prompt, output, cache: { inputs: ['package.json', 'src/**'] } });
```

The key hashes the step's configuration, the contents of its declared input files, the
pipeline's input, every upstream step's Output, and the model name. That deliberately
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
| [0004](docs/adr/0004-sequential-execution.md) | Runs are sequential, but steps still return handles |
| [0005](docs/adr/0005-bun-only.md) | The SDK targets bun, not Node |
| [0006](docs/adr/0006-conservative-cache-keys.md) | Cache keys deliberately over-invalidate |
| [0007](docs/adr/0007-declared-step-names-for-skipped.md) | Skipped steps come from an optional declared step list |

## Licence

MIT.
