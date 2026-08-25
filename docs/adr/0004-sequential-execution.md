# Runs are sequential by default, and command steps may fan out

The runner executes one step at a time. The motivating sketch for this SDK used
`Promise.all` to fan out lint/test/typecheck/build, but that was an illustration of
programmatic control flow rather than a requirement, and concurrent Claude steps sharing
one workspace would race on the same files.

Steps nevertheless return handles rather than plain values, and the flat form
(`pipeline.claude(...)`) is the documented one. Sequential execution is a property of the
runner, not of the API, and keeping handles means concurrency can be added later without
changing how pipelines are written.

## Amendment: `ctx.commands()` runs a group of command steps concurrently

The workspace-race argument is about Claude steps, which edit files; it does not reach a
fan-out of read-only checks, which was the case that motivated the SDK. `ctx.commands()`
runs a declared group of **command steps only**, bounded by an optional `concurrency`.
Claude steps remain strictly sequential, and there is no API to run them otherwise.

Two properties keep a concurrent group as reproducible as a sequential one:

- **Places are claimed before the work starts.** `Runner.beginStep` assigns the index and
  appends the record when the group is declared, so a run records the group in the order
  it was written rather than the order it finished. `execute` re-stamps `startedAt` when
  a step actually begins, so time spent waiting on the concurrency limit is not counted
  as time spent running.
- **Members share one upstream snapshot.** ADR 0006 puts every completed upstream Output
  into a step's cache key. Read live, that set would depend on which sibling happened to
  finish first, and the same group would key differently from one run to the next.
  `ctx.commands()` snapshots the upstream Outputs once, before the group starts, and
  keys every member against it.

A group settles fully before it throws. If one member fails, its siblings are still
allowed to finish and be recorded, rather than the run reporting steps that are forever
`running`; the group then rejects with the first failure in declaration order.

## Consequences

Sequential remains the default and the documented shape: `ctx.commands()` has to be
reached for. The concurrency bound is a counting semaphore whose waiters re-check on
wake — releasing a slot decrements the count before waking anyone, so a waiter that
assumed the slot was still free would let the group exceed its own limit.
