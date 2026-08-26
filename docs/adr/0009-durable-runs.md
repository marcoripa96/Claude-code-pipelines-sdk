# A run survives the death of the process that started it

ADR 0008 made a run *replayable*: a second run can skip work an earlier one already did,
matching on fingerprints. That is enough to retry a failure, and not enough to survive a
crash. The gap is everything a dying process leaves behind — a step recorded as `running`
with no way to know whether its effect landed, a record nobody can load, and no signal
that the run stopped at all.

This ADR closes that gap. A run is durable: killed at any point, it can be picked up and
finished by another process, without a human deciding what already happened.

## The journal records intent, not just history

A step's fingerprint is now computed **before** its `stepStarted` write, not inside the
work. The row therefore says *this step is about to do exactly this work*, and a process
killed mid-step leaves a record that identifies what was in flight. Previously the
fingerprint was written only by `stepFinished`, so a crashed step was an anonymous
`running` row — unmatchable, and so silently redone.

This is the whole reason the rest of this ADR is possible, and it costs nothing: the
fingerprint was already computed from values available before the work began.

## A `running` step of an earlier run is indeterminate, not failed

Resume already refuses to replay `failed` and `skipped` steps, because a failure is
exactly what a resumed run exists to retry. A `running` step is a third thing: its work
may have completed, may have half-happened, or may never have started. Redoing it is
at-least-once, and for a step that opens a merge request that means two merge requests.

A step that matches an indeterminate step of the resumed run resolves in one of three
ways, in order:

1. **`reconcile`** — the step declared how to ask the outside world whether its effect
   landed. It runs, and a value means the effect already happened and is adopted as the
   step's result; `undefined` means it did not, and the step runs normally. A step that
   can ask is never indeterminate afterwards, whatever its `onCrash` says: `onCrash`
   decides only what to do when there is nothing to ask.
2. **`onCrash: 'rerun'`** — the step is safe to repeat, so it is repeated.
3. **`onCrash: 'fail'`** — the run fails with `IndeterminateStepError`, naming the step
   a human must inspect.

The default is by kind, and it is a judgement about which way it is cheaper to be wrong.
`ctx.step` is documented as where External effects live, so a code step defaults to
`'fail'`: a duplicated effect is unrecoverable, while stopping to ask costs a person five
minutes. Claude and command steps default to `'rerun'`: they act on the workspace, which
snapshots (ADR 0011) restore, and their repetition costs tokens and time rather than
correctness. A command that reaches outside the workspace should say `onCrash: 'fail'`.

`undefined` is how a reconcile says the effect did not land, so a step whose own value is
`undefined` cannot be reconciled — it must return something. That is a small tax on the
steps that need it and no tax at all on the ones that do not.

`reconcile` belongs to `ctx.step` alone. Asking the outside world what happened requires
the adapter that talks to it, and that adapter is already the code step's body.

## Storage gains a read path, and ADR 0003 is amended

ADR 0003 made `StorageAdapter` write-only so the SDK would not own a schema. That holds
for the *history*: nothing here reads a transcript back. But a run nobody can load is not
recoverable by anyone except the process that died holding it, which is exactly the case
this ADR exists for.

`StorageAdapter` therefore gains three **optional** methods, and an adapter that
implements none of them is still a valid adapter serving ADR 0003's original case:

- `readRun(runId)` — rebuild a `RunResult`, so `resumeFrom` can be a run id.
- `resumable({ pipeline, staleMs })` — runs still marked `running` whose heartbeat has
  gone quiet. This is what a supervisor polls.
- `heartbeat(runId, at)` — written on an interval while a run is alive. A heartbeat is a
  lease: gone quiet means the owner is gone, and its work may be taken.

The interface stays write-only *by default*. `RunStore` is the name for an adapter that
implements all three, and `pipeline.recover({ runId, storage })` requires one.

`runSuperseded(previous, by)` closes the loop: a recovered run marks the run it took over
as `superseded`, so a supervisor does not pick it up again. `RunStatus` gains that value.

**The takeover is the arbitration.** Two supervisors polling the same store see the same
abandoned run and both try to take it; if both proceed, both finish it and duplicate every
remaining effect — the failure this ADR exists to prevent, reintroduced by the mechanism
meant to fix it. So `runSuperseded` reports whether the claim was won, and the run that
lost stops with `RunTakenError` before any step executes. In the sqlite adapter the
conditional `UPDATE ... WHERE status = 'running'` is that arbitration and its row count is
the answer. An adapter that returns nothing cannot arbitrate and is trusted, which keeps
the method as optional as the rest.

## Consequences

`StepRecord` gains `recovered`, recording that a step was resolved against an
indeterminate predecessor and how — `'reconciled'` or `'rerun'`.

A crashed run's row stays `running` until something supersedes it. That is deliberate:
the row is the only evidence the run existed, and rewriting it to `failed` on a guess
would lose the distinction between *stopped* and *tried and could not*.

Nothing here makes an effect transactional. `reconcile` is a question asked of a system
that already has its own record of what happened; where no such record exists, the honest
answer is `onCrash: 'fail'` and a human.
