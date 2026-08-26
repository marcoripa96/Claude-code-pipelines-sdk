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

The example deliberately returns no changed files, test boolean or model approval. The
implementer's final message is its human-facing report, while Git owns the diff, command
steps own exit codes, and Kanby owns the task-facing outputs, prepared brief, blocking
condition, development links and status trace.

## What a step is

Step boundaries are the one design decision this example is really about, so it is worth
stating precisely rather than by feel. A step is the SDK's atom in four senses at once:

1. **The record unit** — one `StepRecord`: name, status, timing, final message, Output,
   error.
2. **The failure unit** — one retry envelope and one timeout envelope. Everything inside
   a step fails together and is re-attempted together.
3. **The replay unit** — one fingerprint. A resumed run replays or redoes a step whole;
   it cannot enter one halfway.
4. **The naming unit** — the granularity at which a halt reports what did not happen.

> **A step is one named, recorded attempt at work that is atomic under retry, timeout and
> replay, and whose result is the only thing later code may branch on.**

The working rule — **a step has exactly one observable outcome**: a decision (a Claude
Output), one transition of one system of record, or a gate verdict — follows from that
definition rather than standing beside it:

- **One outcome per step**, because a step that wrote GitLab *and* Kanby could not be
  retried without repeating half of it. `open-merge-request` and `link-development` are
  separate because replay demands it, not because it reads better.
- **Homogeneous failure semantics inside a step**, because the retry envelope *is* the
  step: reading back what was pushed (an observation) and opening the merge request
  (irreversible, and what a human is asked to attend to) cannot share one.
- **Gates are one system each too**: `preflight-git` and `preflight-gitlab` are separate
  so a failure names the system that is not provisioned.
- **Formatting, branching and halt checks are code *between* steps** — they have no
  outcome to retry, time out or replay, and they produce no record.
- **A read becomes a step only when its snapshot is an input to a later branch** — that
  is what makes it worth fingerprinting. `fetch-task` qualifies (it gates the branch and
  feeds `claim`'s conditional arguments); the `git status` inside preflight does not.
- **A session and the recording of its decision are different steps**, because a failed
  board write must not re-run the session.

A Claude step records two different artifacts. Its **final message** is the subagent's
human-facing report. Its optional structured **Output** is control data for pipeline code.
Classification, analysis and review declare Output because code branches on their fields;
implementation does not, because its report needs no machine decision and Git is the
authority for what changed.

The pipeline's rhythm reads: **decide → record → gate**, with column moves marking the
chapter boundaries.

## The pipeline

`createKanbyFactory()` accepts unblocked `backlog` or `todo` tasks and detects the stage
from the fetched task:

```text
fetch task
  -> blocked / not in backlog or todo: halt, nothing to do here
  -> todo without both preparation outputs: halt, nothing to undo
claim (conditional on the fetched snapshot)

backlog task:
  classify (Bash only, to read the board)
    -> attach Classification output
    -> low confidence / manual triage: handoff, halt in backlog
  analyze (read-only tools; probes run and are quoted as evidence)
    -> attach Analysis output
    -> not ready: handoff, halt in backlog
  write the implementation-ready brief into task content
  move backlog -> todo

todo task:
  (intake stages are simply not run)

both:
  preflight-git: clean tree, branch and remote agree with the destination
  preflight-gitlab: project and target branch are reachable
  move -> in_progress
  implement prepared brief, committing the work -> attach Implementation output
  verify what was pushed: right branch, clean tree, a real commit, origin at it
  run checks in an isolated sandbox -> attach Checks output
    -> failure: handoff, halt in in_progress
  review through `/code-review`
    -> complete: leave the loop
    -> concerns and revisions remain: revise -> implement again
    -> concerns and revisions exhausted: handoff, halt in in_progress
  confirm the branch is still at the reviewed commit
    -> it moved: handoff, halt in in_progress
  peak risk above the unattended ceiling: handoff, halt in in_progress
  open the merge request on GitLab (find or create)
  record the merge request on the task as its development link
  move in_progress -> in_review
  release

any thrown step after the claim:
  handoff (block with the failure, release), then fail the run
```

A **handoff** is the factory's single stop-and-ask-a-human ritual, shared by every stop
path: record the reason on the card (`handoff-block`), release the claim
(`handoff-release`), then halt. It is declared once, so "a stopped task is always free
for a human to act on" cannot drift out of one path — including the path where a step
*throws*. A failed run still fails, but it hands the card back on the way out, and the
block reason carries the error. Board writes during that unwinding are best-effort: an
unreachable board must not mask the failure that got there.

The branch is code, on a value — the fetched status — never a model turn. A run that
starts at `todo` contains only the stages it executed. A human reviews the full evidence
chain and is the only actor that moves the task from `in_review` to `done`.

Writing the Analysis into task content makes `todo` self-contained: delivery consumes the
prepared task instead of repeating analysis or depending on an in-memory handle from an
earlier run. From that point the **brief is the authoritative copy** — a human editing it
during a restart changes what the implementer reads, and the Analysis output block stays
as the record of what the factory originally proposed.

### Risk decides review depth

The reviewer scores side-effect, performance and compatibility risk, and those scores are
a branch, not decoration. The board has one review column, so the only depth this pipeline
can express is *whether a human decides before the change is published at all*:
`maxUnattendedRisk` (default `medium`) is the ceiling, and a peak above it hands the task
over instead of opening a merge request. Below it, the peak still travels — the Review
output block and the merge request description both carry a suggested review depth, so
the human who opens it knows whether they are giving it a glance or an hour.

### Step names and revision rounds

Every step in the implementation loop carries its round: round two records
`implement-2`, `publish-implementation-2`, `verify-commit-2`, `check-2`,
`publish-checks-2`, `review-2`, `publish-review-2`. A two-round run therefore reads as
fourteen distinct records rather than seven names appearing twice. Those dynamic names
stay outside the declared `steps` list by design; the declared list is only used to record
what a halt stopped the run from reaching (ADR 0007).

One consequence worth knowing: because that list is flat and linear, a halt during a
`todo` run records the intake steps as `skipped` even though the branch never applied to
them. A completed `todo` run has no such records at all — code branching past a stage
produces nothing, a halt is what produces `skipped`.

## Restarting a blocked task

A block is the factory handing control to a human, not an error state. Every stop path
also releases the claim, so a blocked task is always free for a human to act on. The
restart is human work first, pipeline work second:

```sh
# 1. Read the evidence: the block reason and the task's output blocks say what failed
#    (triage needed, analysis not ready, checks failed, review concerns, risk above the
#    ceiling, a step that threw, ...). The run record has the step-by-step history.
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
of continuing from stale intake. `kanby show --json` is expected to include `updated_ms`,
the task's output source/key pairs, and the agent currently holding it (`claim.agent`);
a `todo` task must carry both preparation outputs. The claim holder is what makes the
claim recoverable: it is the one effect here that repeating would fail rather than
duplicate, so a recovered run asks the board who holds the task instead of guessing.

It is also expected to support **two credential scopes**. Every prompt tells the session
to read the board with `kanby show`, while every mutation is a recorded pipeline step —
which only works if a read-only token exists (`KANBY_READ_API_KEY`) that is separate from
the write token the adapter holds.

## Run

The pipeline needs an isolated workspace already on the configured task branch, with
analysis probes treated as throwaway (the run must leave the tree as it found it, or
commit will refuse):

```sh
export WORKSPACE=/checkouts/kanby-task
export KANBY_TASK_GUID=019f...
export KANBY_AGENT=implementer-1
export KANBY_API_KEY=...              # write scope: pipeline steps only
export KANBY_READ_API_KEY=...         # read scope: what sessions get
export GITLAB_HOST=https://gitlab.example.internal
export GITLAB_TOKEN=glpat-...
export GITLAB_PROJECT=group/project
export SOURCE_BRANCH=task/461-first-class-blocking
export TARGET_BRANCH=main
export TEST_COMMAND='bun test'
export SANDBOX_RUNNER=sandbox-exec

# Optional policy knobs; the input schema owns the defaults.
export MAX_REVISIONS=1                # revision rounds before handing over
export MIN_CONFIDENCE=0.8             # below this, classification is a human's question
export MAX_UNATTENDED_RISK=medium     # peak review risk that may reach a merge request
export RUN_DB=.pipelines/runs.sqlite  # the run's own step-by-step history

bun run examples/kanby-software-factory/index.ts --real
```

The entry point captures each credential where it is needed, then removes from the
process environment the ones a session must not see: the write `KANBY_API_KEY` goes to
Kanby subprocesses only and `GITLAB_TOKEN` to GitBeaker only. What remains ambient for a
session is the read-only board token — and `SSH_AUTH_SOCK`, because the implementing
session pushes its own branch.

Bound that credential on the server, not in the prompt. The session pushes to task
branches; protecting `main` (and whatever else you merge into) is what stops it reaching
anything that matters, and it holds regardless of what the model decides to do. Within
those limits a pushed branch is cheap: it affects nobody until the merge request opens,
and the risk gate is what decides whether that happens.

The one thing branch protection does not bound is *other* repositories the key can reach.
A deploy key scoped to this project closes that; a personal agent socket does not.
`SESSION_DENIED` in `adapters.ts` is the seam to narrow it at. Git preflight also verifies
that every fetch/push URL for `origin`, the current branch and the configured GitLab
project agree before implementation starts, and GitBeaker verifies project and
target-branch access, so a misdirected push is caught early.

Prompts are short job statements, not documents. The review step delegates its procedure
to `/code-review`, then supplies only the task, reviewed commit, fixed point and source of
the prepared brief and checks; the pipeline's schema declares the verdict it needs for
control flow. Sessions get the full tool set; the prompt is the guideline, and what
actually holds is verified afterwards rather than forbidden in advance. Tool allow-lists
were tried and removed: a list containing `Bash` restricts nothing, so it bought a false
sense of a guarantee that the checks below already provide for real.

What holds without the model's cooperation: the implementing session commits and pushes,
and `verify-commit` reads back what it left — right branch, clean tree, at least one
commit, and `origin/<branch>` at exactly that commit. A review is therefore bound to an
immutable sha that anyone can fetch, rather than to whatever the working tree happened to
hold. Checks run through `SANDBOX_RUNNER` with no network and no host credentials, and
Git runs with hooks disabled.

The reviewer is a session like any other — same model, same tools, same credentials —
so nothing stops it committing and pushing after it has scored, and a merge request opens
against the *branch*. `confirm-reviewed` observes the branch a second time immediately
before publishing, and stops the run if it is no longer at the commit that was scored.
That is the shape of every guarantee here: not a capability taken away, which a session
with `Bash` can route around, but a fact checked at the point where it matters.

The merge request and every board write stay in pipeline code. A pushed branch affects
nobody on its own; the merge request is the publication, and the risk gate has to be able
to withhold it.

A run that stops is picked up, not restarted. What every step does about a crash that
left it in flight is declared once, as the pipeline's `defaults: { onCrash: 'rerun' }`,
because it is a property of the pipeline rather than of twenty separate steps: the board
writes, Git and GitLab are all repeatable — `move`, `block`, `release` and `development
upsert` are set-operations, `verify-commit` only reads, and `ensure` finds the merge
request before creating one. The single exception is `claim`, which `kanby` guards on the snapshot it was
read from and which would therefore *fail* rather than duplicate; it asks the board
whether the claim is already ours and adopts it if so, which settles the question without
consulting the default at all.

Workspace edits come back from Git rather than from re-running the session that made
them: the run is given `gitWorkspaceSnapshots()`, so a replayed `implement` step restores
the tree it produced. `WORKSPACE` must therefore be the checkout's top level — restoring
rewrites the whole tree, so a directory inside a repository is refused rather than
silently deleting everything above it. Recovery is one command, and takes only the run's id:

```sh
bun examples/kanby-software-factory --real --recover <run-id>
```

Only one run may operate on a task/workspace at a time; a run's heartbeat in
`.pipelines/runs.sqlite` is what says whether the owner is still alive.

## Where this differs from the Vercel factory

The post is the design's source; this example diverges in four places, on purpose:

- **One pipeline, not one agent per task.** The post runs separate agents for bug
  reproduction, fixes, review, backports and docs. Here the classification `type` travels
  into the brief instead of selecting an agent, so the whole factory stays one readable
  control flow. The seam is visible: routing on `type` is where this example would grow.
- **No backporting stage.** The post's sixth stage is out of scope; this pipeline ends at
  human review.
- **Probes are throwaway, not artifacts.** The post's analysis stage leaves probe files
  in the tree as evidence. Preflight here demands a clean workspace, so the analyst is
  asked to *quote* the probe it ran into the Analysis output — re-runnable by a human,
  but not committed.
- **Only checks are sandboxed.** The post runs every agent inside an isolated sandbox.
  Here the sandbox wraps the check command; sessions run in the workspace with scrubbed
  credentials and declared tool limits instead.

## Files

- `contracts.ts` declares what the factory needs from the outside world — the narrow
  client interfaces and the shapes they speak in. `adapters.ts` depends on this rather
  than on the driver that calls it.
- `pipeline.ts` contains the pipeline definition: the stages, the gates and the order.
- `format.ts` holds the markdown the factory publishes to the board and to the merge
  request. Pure functions of their arguments, so they are assertable on their own.
- `adapters.ts` implements the ideal Kanby CLI, local Git and GitBeaker seams.
- `index.ts` composes the real adapters and requires an explicit `--real` flag.
