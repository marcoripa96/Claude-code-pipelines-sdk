# Replay restores results; snapshots restore the workspace

A replayed Claude step hands back its final message and optional Output. It does not hand
back the forty files it edited. For a pipeline whose steps read the tree the previous step
wrote — which is every pipeline worth resuming — replaying recorded results over an
untouched workspace produces a run that is internally consistent and factually wrong.

This is why resume was, until now, something a human supervised. It is also the last thing
standing between a crashed run and an automatic one.

## A snapshot per completed step, restored once

A run may be given a `WorkspaceSnapshots` adapter. After each step completes, the adapter
captures the workspace and the returned id is recorded on the step. On a resumed run,
nothing is restored while steps are replaying; the moment the run reaches a step that must
do real work, the snapshot of the last replayed step is restored, and the run continues
against the tree that step left behind.

Restoring lazily, once, rather than after every replayed step, is the difference between
one restore per resume and one per step. It also gives the right answer for a run where
everything replays: the restore is still owed, so it happens before the run finishes and
the caller is left with a workspace matching the record.

## Git is the default implementation

`gitWorkspaceSnapshots()` captures with plumbing, through a scratch index file so the
workspace's own index is never touched:

- the working tree, via `add -A` into a temporary index, `write-tree`, and `commit-tree`
- the real index, via `write-tree`, so staged state survives too

Each is pointed at by a ref — `refs/pipelines/<runId>/<step>` and `<step>-index` — which
keeps both from being collected and makes a run's intermediate states inspectable with
ordinary Git. A bare tree object is reachable from nothing, so the staged state needs a
ref of its own or the first `git gc` in the workspace takes it. Restoring is
`read-tree --reset -u` for the working tree, `clean -fd` for files created since, and a
second `read-tree` to put the index back.

The workspace must be the repository's **top level**. Capturing is scoped to the directory
it runs in and restoring is not, so a workspace one level down would record part of the
repository and then rewrite all of it — deleting everything outside the workspace. The
adapter refuses rather than scoping every command by pathspec: a workspace that is half a
repository is not what this describes.

Git was chosen because content-addressing gives deduplication for free, the workspace of
the case that motivated this is already a repository, and the result is debuggable by a
human with no SDK-specific tooling.

## Consequences

`StepRecord` gains `snapshot`.

Restoring is destructive by construction: it discards work done after the snapshot,
including untracked files. That is what restoring means, and it is why snapshots are
opt-in per run rather than on by default.

Files Git ignores are not captured, so `node_modules` costs nothing and a build output
under `.gitignore` is not restored. A pipeline that depends on ignored state must rebuild
it in a step.

A non-repository workspace cannot use the Git adapter. The interface is small enough that
a consumer whose workspace is a container image or a filesystem with snapshots implements
their own; ADR 0003's reasoning applies unchanged.
