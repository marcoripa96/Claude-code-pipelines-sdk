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
which a session communicates a decision. A step without a schema returns final text
instead.
_Avoid_: result, response, payload

**External effect**:
A change to any system of record outside the workspace: a label, a comment, a status, a
pull request. Always performed by pipeline code from a step's Output, never by Claude.
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

**Cacheable**:
The property of a step that has opted in by declaring its inputs. Steps are never
cacheable by default, and a cacheable step re-runs whenever anything it could depend on
has changed.
_Avoid_: memoized, pure, idempotent

### Persistence

**Storage adapter**:
A write-only sink receiving a run's lifecycle and transcripts, so that a consumer with
its own database records runs there rather than beside it. History, never the live view.
_Avoid_: logger, reporter, backend

**Cache adapter**:
A small keyed store, separate from the storage adapter because caching needs to read back
what it wrote.
_Avoid_: cache store, memo table
