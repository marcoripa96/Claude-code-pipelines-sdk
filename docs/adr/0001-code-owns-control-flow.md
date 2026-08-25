# Code owns control flow; Claude only supplies values

A pipeline's sequence of steps is decided entirely by TypeScript. A Claude step returns
a schema-validated Output, and pipeline code branches on it; Claude never selects what
runs next. The alternative — letting an agent drive the pipeline, or letting it perform
the consequential action itself via an MCP tool — was rejected because the decision and
its effect would then both happen inside a model turn, invisible to the run report,
unreproducible, and impossible to unit-test with a fixture.

## Consequences

Claude acts on the workspace; code acts on everything outside it. Editing files, running
tests and grepping are Claude's own business, but labels, comments, status changes and
pull requests are performed by pipeline code from a step's Output. Context crosses
between steps as interpolated Output values or as data a step re-reads, never as an
implicit shared conversation.
