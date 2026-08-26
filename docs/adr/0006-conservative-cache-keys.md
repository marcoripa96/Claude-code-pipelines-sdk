# Cache keys deliberately over-invalidate

A cacheable step's key hashes its configuration, the contents of its declared input
files, the pipeline's input values, every upstream step's recorded artifacts, and the
model name. A Claude step contributes both its final message and its optional structured
Output: pipeline code may consume either, and the key deliberately does not guess which.
Hashing only what the step itself declares would be more precise and would produce more
hits.

The asymmetry decides it: over-invalidating costs one re-run, while a silently stale hit
costs an afternoon of confusion and is the failure mode that erodes trust in a build
tool. Including the model name means switching models re-runs Claude steps rather than
reusing Outputs produced by a different one.
