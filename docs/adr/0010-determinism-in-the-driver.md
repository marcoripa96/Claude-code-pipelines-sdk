# Non-determinism belongs in a step, and the SDK supplies the common cases

Resuming re-executes the pipeline's `run` function from the top. Steps that already
happened replay; the code *between* them runs again for real, because it is ordinary
JavaScript and there is nothing to replay it from.

That makes the driver's determinism load-bearing, and it fails in two directions
depending on where the value goes.

**It reaches a step's declaration** — a timestamp in a prompt, a random suffix in a
command. The step's fingerprint changes, so the step re-runs; its Output changes, so
every step below it re-runs too. A `Date.now()` in the driver does not merely produce a
different number, it re-does the rest of the run, effects included.

**It stays in a closure** — read into a local and used inside a code step's body. A code
step's identity is its source, and a captured value is invisible to that (ADR 0008). So
the step replays, the driver's freshly-read value is discarded, and nothing anywhere
says so.

The first is loud and expensive; the second is silent and wrong. One rule closes both.

## The rule

Everything that can differ between two executions of the same pipeline must come from a
step. Steps are the recorded points; the code between them must be a pure function of
what they returned.

In practice that means the driver must not read the clock, generate randomness, read the
filesystem, or read the environment. All of those are legitimate — inside `ctx.step`,
where the answer is recorded once and replayed thereafter.

## The three that are too easy to get wrong

Writing `await ctx.step('now', () => Date.now())` is correct and nobody does it, so the
SDK supplies the cases that actually occur:

```ts
const at = await ctx.now();      // Date.now(), recorded
const roll = await ctx.random(); // Math.random(), recorded
const id = await ctx.uuid();     // crypto.randomUUID(), recorded
```

Each is a real step with a real record, named `now#1`, `random#2`, `uuid#3` by position,
and each replays like any other. They are recorded under the step kind `value` so a
consumer reading a run's history can tell them apart from work.

Naming them by position rather than by a caller-supplied label is what keeps them
ergonomic, and it is also what makes them fragile in one specific way: inserting a
`ctx.now()` above another one renumbers it, and the renumbered step re-runs. That is the
same conservatism as ADR 0006 — editing the pipeline invalidates what the edit could have
changed — and re-reading the clock costs nothing.

## Consequences

`StepKind` gains `'value'`. A run of a pipeline that never calls these is unchanged.

The rule is not enforced; a driver that reads the clock directly still runs, and still
resumes wrongly. Enforcing it would mean owning the driver's execution the way a durable
workflow engine does, which ADR 0001 rejects — control flow is the pipeline author's.
What the SDK can do is make the correct thing shorter than the incorrect one.
