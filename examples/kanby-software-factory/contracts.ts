/**
 * What the factory needs from the outside world, and the shapes it speaks in.
 *
 * Separate from the pipeline because these are what `adapters.ts` implements: the
 * adapters depend on the contract, not on the driver that happens to call them.
 */

export type TaskStatus = 'backlog' | 'todo' | 'in_progress' | 'in_review' | 'done';

/**
 * Ordered from least to most: `rank()` reads the ordering off this array, so the
 * levels and their severity order are one declaration rather than two that can drift.
 */
export const RISK_LEVELS = ['none', 'low', 'medium', 'high'] as const;

export type RiskLevel = (typeof RISK_LEVELS)[number];

export interface KanbyTask {
  guid: string;
  displayNumber: number | null;
  title: string;
  description: string;
  content: string;
  status: TaskStatus;
  blocked: { reason: string } | null;
  /** The agent currently holding the task, if any. What a recovered claim asks about. */
  claimedBy: string | null;
  updatedMs: number;
  outputKeys: string[];
}

export interface TaskOutputInput {
  key: string;
  title: string;
  body: string;
}

export interface MergeRequestRef {
  provider: 'gitlab';
  host: string;
  project: string | number;
  iid: number;
  url: string;
  title: string;
  sourceBranch: string;
  targetBranch: string;
  state: 'opened' | 'closed' | 'merged' | 'locked';
}

export interface GitLabDestination {
  host: string;
  project: string;
  sourceBranch: string;
  targetBranch: string;
}

export interface KanbyClient {
  /** The agent identity this client acts as. A recovered run asks whether it already holds a claim. */
  readonly actor: string;
  get(taskGuid: string, workspace: string, signal: AbortSignal): Promise<KanbyTask>;
  claim(task: KanbyTask, workspace: string, signal: AbortSignal): Promise<void>;
  release(taskGuid: string, workspace: string, signal: AbortSignal): Promise<void>;
  move(
    taskGuid: string,
    status: Extract<TaskStatus, 'todo' | 'in_progress' | 'in_review'>,
    workspace: string,
    signal: AbortSignal,
  ): Promise<void>;
  update(
    taskGuid: string,
    changes: { content: string },
    workspace: string,
    signal: AbortSignal,
  ): Promise<void>;
  block(taskGuid: string, reason: string, workspace: string, signal: AbortSignal): Promise<void>;
  putOutput(
    taskGuid: string,
    output: TaskOutputInput,
    workspace: string,
    signal: AbortSignal,
  ): Promise<void>;
  linkMergeRequest(
    taskGuid: string,
    mergeRequest: MergeRequestRef,
    workspace: string,
    signal: AbortSignal,
  ): Promise<void>;
}

/**
 * The commit a review is bound to.
 *
 * The implementing session commits its own work — `.git` is inside the workspace, and
 * committing is a workspace action like any other. What the pipeline does is *observe*
 * what the session left, and name it: from here on the change is one immutable object
 * rather than whatever the working tree happens to hold, so the diff the reviewer scored
 * is provably the diff that gets pushed.
 */
export interface CommitUnderReview {
  /** What the session left at HEAD, and what the remote branch now points at. */
  sha: string;
  /** The merge base with the target branch: what the change is measured against. */
  base: string;
  /** How many commits the session left. Zero means it committed nothing. */
  commits: number;
}

export interface RepositoryClient {
  preflight(
    workspace: string,
    destination: GitLabDestination,
    signal: AbortSignal,
  ): Promise<void>;
  /**
   * Reads back what the implementing session committed and pushed, and refuses anything
   * a review could not be bound to: the wrong branch, a dirty tree, no commit at all, or
   * a remote branch that is not at the commit under review.
   *
   * The session does the committing and the pushing; this only observes. A branch on the
   * remote affects nobody on its own — the merge request is the publication, and that is
   * what the risk gate withholds.
   */
  verifyCommit(
    workspace: string,
    destination: GitLabDestination,
    signal: AbortSignal,
  ): Promise<CommitUnderReview>;
}

export interface ChecksClient {
  run(
    workspace: string,
    command: string,
    signal: AbortSignal,
  ): Promise<{ stdout: string; stderr: string; exitCode: number }>;
}

export interface MergeRequestsClient {
  preflight(
    destination: Pick<GitLabDestination, 'host' | 'project' | 'targetBranch'>,
    signal: AbortSignal,
  ): Promise<void>;
  ensure(
    request: {
      host: string;
      project: string | number;
      sourceBranch: string;
      targetBranch: string;
      title: string;
      description: string;
    },
    signal: AbortSignal,
  ): Promise<MergeRequestRef>;
}

export interface KanbyFactoryDependencies {
  kanby: KanbyClient;
  repository: RepositoryClient;
  mergeRequests: MergeRequestsClient;
  checks: ChecksClient;
}
