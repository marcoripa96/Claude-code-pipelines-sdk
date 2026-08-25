# Resume takes the previous run's record, not a read from storage

A failed run can be resumed by passing the earlier `RunResult` as `resumeFrom`. Every
step whose work is unchanged replays that run's result instead of doing it again, so a
failure in step nine costs step nine rather than the eight sessions before it.

The obvious alternative — `resumeFrom: runId`, with the SDK loading the run out of
storage — was rejected because ADR 0003 makes `StorageAdapter` write-only on purpose. It
is the consumer's database, queried with the consumer's own SQL, and giving the SDK a
read path would put it back in the business of owning a schema. A caller already holds
the record: `run()` returns it, and `runFinished` carries it. One that persisted the run
and came back tomorrow rebuilds the record with its own query and hands it in; the
default sqlite adapter stores everything that takes.

## Matching is by fingerprint

Every step now computes a **fingerprint**, whether or not it is cacheable: the same
value ADR 0006 already defined as a cache key — the step's declaration, its declared
input files, the pipeline input, the model, and every upstream Output. A step replays
only when a *completed* step of the resumed run has the identical fingerprint.

Reusing one value for both is deliberate. Caching and resuming ask the same question —
*has this exact work already produced a result?* — and differ only in where the answer is
kept. They are one lookup, tried against the resumed run first because that answer is
both more specific and free.

Because a fingerprint covers the Outputs above a step, the chain takes care of itself: a
step that genuinely produces something different invalidates everything downstream,
while a step that re-runs and produces the *same* Output leaves the steps below it
replayable. What matters is the Output above a step, not whether that step happened to
re-run.

## Consequences

Code steps replay, and that is the point: `ctx.step` is where External effects live, so a
resumed run must not post the comment or open the pull request a second time. A code
step's identity includes its source, so editing the function runs it again — imperfect,
since a closure's captured values are invisible, and deliberately conservative in the
same direction as ADR 0006.

Failed and skipped steps are never replayed. A step that failed is exactly the step a
resumed run exists to retry.

`StepRecord` gains `fingerprint` and `replayed`, and the sqlite adapter gains two
columns. `CREATE TABLE IF NOT EXISTS` leaves an existing table alone, so the adapter
adds them explicitly when opening a database that predates them.
