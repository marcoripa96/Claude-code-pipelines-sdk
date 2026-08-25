# Skipped steps come from an optional declared step list

A pipeline's `run` function is ordinary imperative TypeScript, so the runner learns a
step exists only when the code reaches it. That is the whole point of ADR 0001, but it
leaves nothing to record when a Halt stops a run early: the glossary says steps not
reached are recorded as skipped, and after a halt there is no way to know what those
steps would have been.

A pipeline may therefore declare `steps: ['classify', 'analyze', ...]` — the step names
it may run, in order. When a run halts, every declared name without a record is written
as a `skipped` step. Without the declaration a halted run simply records the steps it
ran, and nothing is lost but the skipped rows.

The rejected alternative was to keep executing the `run` function after a halt with every
`ctx.*` call short-circuiting. That would have discovered the remaining step names for
free, but the plain code between steps — the External effects, the branch conditions
reading Outputs that no longer exist — would have kept running against a run that was
supposed to have stopped. A halt that keeps executing code is not a halt.

## Consequences

The list is documentation the runner happens to use, not a graph: it is not validated
against what actually ran, and it does not constrain branching. A step name that appears
in the list but is skipped by a branch on a completed run is not recorded at all —
`skipped` means "the run halted before reaching this", exactly as the glossary defines
it, and never "this branch was not taken".
