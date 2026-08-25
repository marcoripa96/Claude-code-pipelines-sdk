# Runs are sequential, but steps still return handles

The runner executes one step at a time. The motivating sketch for this SDK used
`Promise.all` to fan out lint/test/typecheck/build, but that was an illustration of
programmatic control flow rather than a requirement, and concurrent Claude steps sharing
one workspace would race on the same files.

Steps nevertheless return handles rather than plain values, and the flat form
(`pipeline.claude(...)`) is the documented one. Sequential execution is a property of the
runner, not of the API, and keeping handles means concurrency can be added later without
changing how pipelines are written.
