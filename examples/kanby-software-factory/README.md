# Kanby software factory

This worked example follows the staged model described in Vercel's
[AI SDK software factory](https://vercel.com/blog/building-a-software-factory-for-ai-sdk):
classification, analysis, implementation and review are separate Claude sessions with
durable evidence between them — but it is **one pipeline**. The pipeline reads where the
task is on the board and runs exactly the stages that stage still needs.

Kanby's workflow columns are contracts between the stages:

```text
backlog       intake without an accepted classification and analysis
todo          classified, analyzed and implementation-ready
in_progress   implementation is running or needs intervention
in_review     a pushed change and merge request await a human
done          human-approved completion
```

The example deliberately returns no changed files, test boolean, model approval or
delivery summary. Git owns the diff, command steps own exit codes, and Kanby owns the
task-facing outputs, prepared brief, blocking condition, development links and status
trace.

## The pipeline

`createKanbyFactory()` accepts unblocked `backlog` or `todo` tasks and detects the stage
from the fetched task:

```text
fetch task
  -> blocked / in_progress / in_review / done: halt, nothing to do here
claim (conditional on the fetched snapshot)

backlog task:
  classify without tools
    -> attach Classification output
    -> low confidence / manual triage: handoff, halt in backlog
  analyze with read-only tools plus Bash for probes
    -> attach Analysis output
    -> not ready: handoff, halt in backlog
  write the implementation-ready brief into task content
  move backlog -> todo

todo task:
  (intake stages are simply not run)

both:
  preflight: clean task branch, Git remote and GitLab access
  move -> in_progress
  implement prepared brief -> attach Implementation output
  run checks in an isolated sandbox -> attach Checks output
    -> failure: handoff, halt in in_progress
  stage the whole change (new files included)
    -> oversized change: handoff, halt in in_progress
  independent review, reading the task and the staged diff itself
    -> complete: leave the loop and publish
    -> concerns and revisions remain: revise -> implement again
    -> concerns and revisions exhausted: handoff, halt in in_progress
  commit
  push
  open the merge request on GitLab (find or create)
  record the merge request on the task as its development link
  move in_progress -> in_review
  release
```

A **handoff** is the factory's single stop-and-ask-a-human ritual, shared by every
block path: record the reason on the card (`handoff-block`), release the claim
(`handoff-release`), then halt. It is declared once, so "a blocked task is always free
for a human to act on" cannot drift out of one path.

### What a step is

Step boundaries follow one rule: **a step has exactly one observable outcome** — a
decision (a Claude Output), one transition of one system of record, or a gate verdict.
Three consequences:

- Formatting, branching and halt checks are code *between* steps; they produce no
  record. Reads become steps only when the snapshot matters (`fetch-task` gates the
  branch and feeds `claim`'s conditional arguments).
- Every board, git and GitLab write is its own step — never two systems in one step,
  never half a transition split across steps (`open-merge-request` and
  `link-development` are separate for exactly this reason).
- Failure semantics stay homogeneous inside a step: `commit` (local, reversible) and
  `push` (remote, irreversible) never merge, and a model session never shares a step
  with the board write that records its Output.

The pipeline's rhythm reads: **decide → record → gate**, with column moves marking the
chapter boundaries. Revision rounds extend `implement`, `test` and `review` with a
`-2`, `-3`, ... suffix; those dynamic names stay outside the declared `steps` list.

The branch is code, on a value — the fetched status — never a model turn. A run that
starts at `todo` contains only the stages it executed; the SDK records steps as `skipped`
when a halt stops a run, not when code branches past a stage. A human reviews the full
evidence chain and is the only actor that moves the task from `in_review` to `done`.

Writing the Analysis into task content makes `todo` self-contained: delivery consumes
the prepared task instead of repeating analysis or depending on an in-memory handle from
an earlier run.

## Restarting a blocked task

A block is the factory handing control to a human, not an error state. Every block path
also releases the claim, so a blocked task is always free for a human to act on. The
restart is human work first, pipeline work second:

```sh
# 1. Read the evidence: the block reason and the task's output blocks say what failed
#    (triage needed, analysis not ready, checks failed, review concerns, ...).
kanby show <task-guid>

# 2. Fix the cause: edit the prepared brief, answer a question, fix the environment.
#    For a task blocked mid-implementation, move it back to todo — backward moves are
#    always allowed, and its preparation outputs keep the todo contract satisfied.
kanby unblock <task-guid>
kanby move <task-guid> todo        # only if it was blocked while in_progress

# 3. Reset the workspace (preflight demands a clean tree) and re-run the pipeline.
git -C /checkouts/kanby-task reset --hard origin/main
bun run examples/kanby-software-factory/index.ts --real
```

Stage detection does the rest. An unblocked `backlog` task re-runs intake from
classification; an unblocked `todo` task goes straight to implementation. Output blocks
are addressed by stable stage keys, so a re-run updates the visible blocks while Kanby's
events preserve the history of every previous attempt.

## Ideal Kanby CLI

`adapters.ts` invokes an intended v2 interface. It does not claim every command exists
in the current CLI yet.

```sh
kanby show <task-guid> --json
kanby claim <task-guid> --as <actor> --if-status <status> --if-updated-ms <clock> --if-unblocked
kanby release <task-guid>
kanby update <task-guid> --content -
kanby move <task-guid> todo|in_progress|in_review
kanby block <task-guid> --reason -
kanby unblock <task-guid>
kanby output upsert <task-guid> --source <source> --key <key> --title <title> --body -
kanby development upsert <task-guid> --provider gitlab --host <host> \
  --project <project> --iid <iid> --url <url> \
  --source-branch <branch> --target-branch <branch> --title <title> --state opened
```

Mutations obey the ordinary claim and workflow gates. Output keys are stable stage slots,
such as `kanby-software-factory/analysis`, so a later run updates the visible block while
Kanby's events retain the change history. Development records are idempotent by GitLab
host, project and merge-request IID.

Conditional claim arguments make the fetched task snapshot part of the claim: if status,
blocking, content or another task field changed after the fetch, claiming refuses instead
of continuing from stale intake. `kanby show --json` is expected to include `updated_ms`
and the task's output source/key pairs; a `todo` task must carry both preparation outputs.

## Run

The pipeline needs an isolated workspace already on the configured task branch, with
analysis probes treated as throwaway (the run must leave the tree as it found it, or
commit will refuse):

```sh
export WORKSPACE=/checkouts/kanby-task
export KANBY_TASK_GUID=019f...
export KANBY_AGENT=implementer-1
export KANBY_API_KEY=...
export GITLAB_HOST=https://gitlab.example.internal
export GITLAB_TOKEN=glpat-...
export GITLAB_PROJECT=group/project
export SOURCE_BRANCH=task/461-first-class-blocking
export TARGET_BRANCH=main
export TEST_COMMAND='bun test'
export MAX_REVISIONS=1
export SANDBOX_RUNNER=sandbox-exec

bun run examples/kanby-software-factory/index.ts --real
```

The entry point captures each credential where it is needed, then deletes all of them
from the process environment before opening a Claude session: `GITLAB_TOKEN` goes to
GitBeaker only, `KANBY_AGENT`/`KANBY_API_KEY` only to Kanby subprocesses, and
`SSH_AUTH_SOCK` only to `git push`. Git preflight verifies that every fetch/push URL for
`origin`, the current branch and the configured self-hosted GitLab project agree before
implementation starts, and verifies them again before push. GitBeaker verifies project
and target-branch access before implementation starts.

Prompts are short job statements, not documents: each names the task and points at the
sources — `kanby show` for board truth (the brief and recorded checks live there),
`git diff --cached` for the change — and the model chooses its own path from there.
Sessions get read-only access by design: their environment carries no board-write or
push credentials, so every write remains a recorded pipeline step. What is enforced is
enforced outside the model: credentials are scrubbed from the process environment,
checks run through `SANDBOX_RUNNER` with no network and no host credentials, Git runs
with hooks disabled, and commit refuses to run if the workspace changed after the
change was staged. A change too large to review blocks the task instead of being
silently cut.

The example deliberately does not use `resumeFrom`. Replaying a Claude step restores its
Output, not workspace edits. A stopped run requires the workspace and task to be inspected
before starting a fresh run. Only one run may operate on a task/workspace at a time.

## Files

- `pipeline.ts` contains the pipeline definition and its narrow dependency interfaces.
- `adapters.ts` implements the ideal Kanby CLI, local Git and GitBeaker seams.
- `index.ts` composes the real adapters and requires an explicit `--real` flag.
