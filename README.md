# claude-pipelines

Deterministic, code-first pipelines for the Claude Agent SDK.

A pipeline is an ordinary async function. A node is a shell command, a Claude Code
invocation, or a plain function. Dependencies are `await`, fan-out is
`Promise.all`, and branching is `if`. There is no canvas, no YAML, and no graph to
keep in sync with the code — the graph *is* the code.

```ts
import { definePipeline } from 'claude-pipelines';

const ci = definePipeline({
  name: 'ci',
  run: async (ctx) => {
    const deps = await ctx.exec({
      name: 'install',
      command: 'bun install --frozen-lockfile',
      cache: { inputs: ['package.json', 'bun.lock'] },
    });

    await Promise.all([
      deps.exec({ name: 'lint', command: 'bun run lint' }),
      deps.exec({ name: 'test', command: 'bun test' }),
      deps.exec({ name: 'typecheck', command: 'bun run typecheck' }),
      deps.exec({ name: 'build', command: 'bun run build' }),
    ]);

    await deps.exec({ name: 'deploy', command: 'bun wrangler deploy' });
  },
});

await ci.run();
```

Every node result can spawn its own children, so `deps.exec(...)` reads as "this
depends on install" and is recorded that way in the graph, the journal and the
cache key.

## Install

```sh
bun add claude-pipelines
```

Claude nodes shell out to the Claude Code CLI through
`@anthropic-ai/claude-agent-sdk`, so they use whatever credentials `claude` is
already logged in with — including a Pro/Max subscription. Nothing else to
configure. (If `ANTHROPIC_API_KEY` is set in the environment, the CLI will bill
the API instead; unset it for subscription runs.)

Requires Bun or Node 22+.

## The three node kinds

### `exec` — a shell command

```ts
const build = await ctx.exec({
  name: 'build',
  command: 'bun run build',
  env: { NODE_ENV: 'production' },
  timeout: 5 * 60_000,
  retry: { attempts: 3, backoffMs: 2000 },
});

build.stdout; // full output
build.text;   // stdout, trimmed
build.exitCode;
```

A non-zero exit fails the node and the run. Pass `allowFailure: true` to get the
exit code back instead.

### `claude` — a Claude Code invocation

```ts
const review = await build.claude({
  name: 'review',
  prompt: 'Review the diff on this branch for correctness bugs.',
  skills: ['code-review'],          // enable a skill for this node
  tools: ['Read', 'Grep', 'Glob'],  // the base tool set
  model: 'claude-sonnet-5',
  maxTurns: 20,
});

review.text;      // final assistant text
review.sessionId; // pass to a later node's `resume` to continue the conversation
review.costUsd;
review.usage;
```

Claude nodes run headless. `permissionMode` defaults to `'dontAsk'`, so a tool the
pipeline did not allow is **denied** rather than blocking forever on a prompt no
one is there to answer. Everything else the Agent SDK accepts is available —
`systemPrompt`, `agents`, `mcpServers`, `settingSources` — plus an `options`
escape hatch merged in last.

### Structured output

Give a node an `output` schema and it returns validated, typed data instead of
prose. The schema is passed to the CLI as a JSON Schema, so the model is
constrained up front rather than asked nicely:

```ts
import { definePipeline, z } from 'claude-pipelines';

const triage = await ctx.claude({
  name: 'triage',
  prompt: 'Classify this failing test.',
  output: z.object({
    cause: z.enum(['flake', 'real-bug', 'infra']),
    confidence: z.number().min(0).max(1),
  }),
});

if (triage.output.cause === 'real-bug') { /* typed, checked, branchable */ }
```

Zod, any [Standard Schema](https://standardschema.dev) implementation, or a raw
`{ jsonSchema }` all work.

### `step` — your own code

```ts
const parsed = await deps.step({
  name: 'parse-coverage',
  run: async ({ log, signal }) => {
    const report = JSON.parse(await readFile('coverage.json', 'utf8'));
    log(`coverage ${report.total}%`);
    return report;
  },
});

parsed.value.total;
```

Code that runs as a `step` is a real node: it appears in the graph, it is timed
and journaled, it can be cached, and things can depend on it. Code that does not
need to be a node is just code — write it inline.

## What "deterministic" means here

Models are not deterministic; the pipeline around them is. Concretely:

**The graph is fixed by the code.** No scheduler decides what runs — `await`
does. Read the function top to bottom and you know the order.

**Every node has a fingerprint.** A content hash of its spec, its declared file
inputs, and its parents' fingerprints. Same fingerprint ⇒ same expected result.

**Caching is opt-in and honest.** A node is only cached if you declare what its
result depends on:

```ts
await ctx.exec({
  name: 'install',
  command: 'bun install --frozen-lockfile',
  cache: { inputs: ['package.json', 'bun.lock'] },  // globs, files or directories
});
```

Because a child's fingerprint includes its parents', a changed lockfile
invalidates the install *and* everything chained off it. Nothing else is cached
behind your back — a node with no `cache` always runs.

**Failed runs resume.** Every run writes a JSONL journal. Point a new run at a
previous one and every node whose fingerprint already succeeded is replayed from
the journal; execution restarts at the first node that did not:

```ts
const first = await pipeline.tryRun(input);
if (!first.ok) await pipeline.run(input, { resumeFrom: first.runId });
```

That is what makes an expensive multi-node Claude pipeline survivable: a failure
in node 9 costs you node 9, not the eight model calls before it.

Escape hatches: `{ force: ['node-name'] }` re-executes specific nodes, and
`{ noCache: true }` bypasses the store for a run.

## Inputs

Declare what the pipeline takes and it is validated before any node runs:

```ts
const release = definePipeline({
  name: 'release',
  input: z.object({ tag: z.string(), dryRun: z.boolean().default(false) }),
  run: async (ctx) => ctx.input.tag,
});

await release.run({ tag: 'v1.2.0' });
```

Use `inputType<{ tag: string }>()` for typing without a validation library.

## Observing a run

```ts
const run = await pipeline.run(input);

run.value;     // whatever `run` returned, typed
run.nodes;     // every node with status, timing, attempts, cache state
run.costUsd;   // total reported Claude cost
run.graph;     // the DAG that actually executed
run.runId;     // resume handle
```

`toMermaid(run.graph)` and `toText(run.graph)` render it. A console reporter is on
by default when stderr is a TTY (`reporter: false` to silence it, `PIPELINE_VERBOSE=1`
for tool calls and command output), and `pipeline.on(listener)` gives you the raw
event stream to build your own.

`run()` throws a `PipelineRunError` on failure; `tryRun()` returns
`{ ok: false, error, nodes, runId }` instead.

State lives in `.pipeline/` — `cache/` for results, `runs/<runId>/` for journals
and summaries. Add it to `.gitignore`, or point `stateDir` somewhere shared to
cache across machines.

## Concurrency

```ts
definePipeline({
  name: 'ci',
  concurrency: { exec: 8, claude: 3, step: Infinity },  // these are the defaults
  claude: { model: 'claude-sonnet-5', tools: ['Read', 'Grep'] },  // inherited by every claude node
  run: async (ctx) => { /* ... */ },
});
```

`Promise.all` says what *may* run together; the limits say what actually does.
Claude nodes default to a lower cap because each is a separate CLI process.

## Examples

- [`examples/ci.ts`](examples/ci.ts) — install, fan out checks, deploy.
- [`examples/triage.ts`](examples/triage.ts) — shell + model + code: review a diff
  with structured output, then fan out one verifier per finding.

```sh
bun run examples/ci.ts
bun test
```

## License

MIT
