# Claude Code Pipelines SDK

A TypeScript library for building deterministic pipelines whose steps are Claude Code
sessions, shell commands, or ordinary code. The pipeline's shape is always decided by
code; Claude only ever supplies values that code branches on.

## Language

### Structure

**Pipeline**:
A named, reusable sequence of steps with a declared input schema.
_Avoid_: workflow, flow, chain, DAG

**Step**:
One unit of work in a pipeline. Primitively a JS function; `claude()`, `command()` and
`step()` are the three ways to declare one, and arbitrary code is a peer of Claude.
_Avoid_: node, task, job, action

**Handle**:
The value a step returns. Steps return handles rather than plain values so that
dependencies stay expressible and concurrency remains possible later.
_Avoid_: ref, token, promise

**Run**:
A single execution of a pipeline against one input and one workspace.
_Avoid_: invocation, execution, job

**Workspace**:
The directory a run operates in. Supplied per run, because the thing a pipeline works on
may be a different checkout each time.
_Avoid_: repo, cwd, sandbox

### Effects

**Output**:
The schema-validated object a Claude step returns to pipeline code. The only channel by
which a session communicates a decision. A step without a schema has no Output; its handle
still carries the final message.
_Avoid_: result, response, payload

**Final message**:
The human-facing report a Claude session ends with. Every Claude step records one,
whether or not it also declares structured Output. Pipeline code uses Output for decisions;
humans review the final message.
_Avoid_: text, response, payload

**External effect**:
A change to any system of record outside the workspace: a label, a comment, a status, a
pull request. Always performed by pipeline code from a recorded step result, never by
Claude directly.
_Avoid_: side effect, action, mutation

### Execution

**Fixed control flow**:
The property that the sequence of steps is determined by code alone. An LLM may produce
an Output that code branches on, but never selects the next step itself.
_Avoid_: determinism, static graph

**Halt**:
A deliberate, successful early termination of a run, distinct from a failure. Steps not
reached are recorded as skipped.
_Avoid_: abort, cancel, bail, exit

**Skipped**:
The state of a step that never ran because the run halted before reaching it.
_Avoid_: ignored, bypassed

**Replay**:
Producing a step's result from a previous run's record instead of doing the work again.
Matched on fingerprint, so a step replays only when its work is identical.
_Avoid_: skip, cache hit, reuse

**Fingerprint**:
The identity of a step's work: its declaration, its declared input files, the pipeline
input, the model, and every upstream step's recorded artifacts. Written when the step starts, so a step a
crash interrupts is still identifiable. Also the cache key of a cacheable step.
_Avoid_: hash, signature, key

**Indeterminate**:
The state of a step whose process died while it was running: its work may have landed,
may have half-landed, may never have started. Neither replayed nor blindly redone.
_Avoid_: stuck, orphaned, unknown

**Reconcile**:
Asking the system a step acts on whether its External effect already landed, so a
recovered run adopts it rather than repeating it.
_Avoid_: check, verify, dedupe

**Recover**:
Picking up a run another process left unfinished and carrying it to an end. Distinct from
resuming, which is a caller re-running a record it already holds.
_Avoid_: restart, retry, resurrect

**Lease**:
A run's heartbeat, renewed while it is alive. Gone quiet means its owner is gone and its
work may be taken.
_Avoid_: lock, claim, ownership

**Snapshot**:
The workspace as one step left it, recorded so a later run that replays that step can put
the tree back. Recorded results replay; files do not, without one.
_Avoid_: checkpoint, backup, image

**Cacheable**:
The property of a step that has opted in by declaring its inputs. Steps are never
cacheable by default, and a cacheable step re-runs whenever anything it could depend on
has changed.
_Avoid_: memoized, pure, idempotent

### Persistence

**Storage adapter**:
A sink receiving a run's lifecycle and transcripts, so that a consumer with its own
database records runs there rather than beside it. History, never the live view. Its
required half is write-only; the optional half reads runs back, which is what makes them
recoverable by a process that was not there when they died.
_Avoid_: logger, reporter, backend

**Run store**:
A storage adapter that also reads: `readRun`, `resumable`, `heartbeat`. What recovery
needs, and what `sqliteStorage()` is.
_Avoid_: database, repository, registry

**Cache adapter**:
A small keyed store, separate from the storage adapter because caching needs to read back
what it wrote.
_Avoid_: cache store, memo table

**Workspace snapshots**:
An adapter that captures and restores a workspace, so replaying a step restores the files
it wrote and not only its recorded result.
_Avoid_: fs adapter, snapshotter, vcs
