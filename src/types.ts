import type { Options as AgentOptions, PermissionMode, SettingSource } from '@anthropic-ai/claude-agent-sdk';

export type NodeKind = 'exec' | 'claude' | 'step';

export type NodeStatus = 'success' | 'failed' | 'cached' | 'replayed';

/** Identity and bookkeeping for a single executed node. */
export interface NodeInfo {
  /** Unique, user-chosen name. Doubles as the node id inside a run. */
  name: string;
  kind: NodeKind;
  /**
   * Content hash of everything the node's result depends on: its spec, its
   * declared file inputs and the fingerprints of its parents. Two runs that
   * produce the same fingerprint are expected to produce the same result.
   */
  fingerprint: string;
  /** Names of the nodes this node was derived from (`parent.exec(...)`). */
  parents: string[];
  status: NodeStatus;
  startedAt: number;
  durationMs: number;
  /** True when the result came from the cross-run cache or a resumed journal. */
  fromCache: boolean;
  attempts: number;
  error?: string;
}

/** Declares what a node's cache key is made of. */
export interface CacheSpec {
  /** File paths, directories or globs (relative to the node's cwd) hashed into the key. */
  inputs?: string[];
  /** Extra JSON-serializable key material, e.g. a tool version or an env value. */
  key?: unknown;
  /** Bump to invalidate every entry produced by an older version of this node. */
  version?: string | number;
}

export interface RetrySpec {
  attempts: number;
  /** Base delay in ms; doubled on each attempt. Default 500. */
  backoffMs?: number;
  /** Return false to stop retrying a given error. */
  when?: (error: unknown, attempt: number) => boolean;
}

export interface NodeSpecBase {
  /** Unique within a run. Used for logs, the journal, the graph and resume. */
  name: string;
  /** Opt in to the cross-run content-addressed cache. Off unless specified. */
  cache?: boolean | CacheSpec;
  retry?: number | RetrySpec;
  /** Abort the node after this many milliseconds. */
  timeout?: number;
}

export interface ExecSpec extends NodeSpecBase {
  /** Shell command line. Runs through the platform shell. */
  command: string;
  /** Defaults to the pipeline cwd. */
  cwd?: string;
  /** Merged over `process.env`. Values here are part of the cache key. */
  env?: Record<string, string | undefined>;
  /** Feed data to the command's stdin. */
  stdin?: string;
  /** Resolve instead of throwing on a non-zero exit code. */
  allowFailure?: boolean;
  /** Stream stdout/stderr lines as `node:log` events. Default true. */
  stream?: boolean;
}

/** A schema that can both describe and validate a Claude node's output. */
export type OutputSchema<T> =
  | { readonly '~standard': { validate: (value: unknown) => { value: T } | { issues: readonly unknown[] } | Promise<{ value: T } | { issues: readonly unknown[] }> } }
  | { parse: (value: unknown) => T }
  | { jsonSchema: Record<string, unknown>; parse?: (value: unknown) => T };

export interface ClaudeSpec<T = string> extends NodeSpecBase {
  /** The task for this node. */
  prompt: string;
  /** Skills to enable, by name (`code-review`) or plugin-qualified (`plugin:skill`). */
  skills?: string[] | 'all';
  /** Base tool set. Defaults to the pipeline's `tools`, else Claude Code's preset. */
  tools?: AgentOptions['tools'];
  /** Tools auto-approved without a permission prompt. */
  allowedTools?: string[];
  disallowedTools?: string[];
  /**
   * When set, the node returns validated structured data in `.output` instead of
   * free text. Accepts a Zod schema, any Standard Schema, or `{ jsonSchema }`.
   */
  output?: OutputSchema<T>;
  model?: string;
  fallbackModel?: string;
  maxTurns?: number;
  /** Replaces or appends to the system prompt. Default: the Claude Code preset. */
  systemPrompt?: AgentOptions['systemPrompt'];
  /** Shorthand for appending to the Claude Code preset system prompt. */
  appendSystemPrompt?: string;
  /** Default `'dontAsk'` — never blocks on a prompt, denies what is not allowed. */
  permissionMode?: PermissionMode;
  /** Required when `permissionMode: 'bypassPermissions'`. */
  allowDangerouslySkipPermissions?: boolean;
  /** Which on-disk settings to load. Default `['project']`. */
  settingSources?: SettingSource[];
  cwd?: string;
  env?: Record<string, string | undefined>;
  /** Continue a previous Claude node's session: `resume: previous.sessionId`. */
  resume?: string;
  mcpServers?: AgentOptions['mcpServers'];
  agents?: AgentOptions['agents'];
  /** Escape hatch: merged last into the Agent SDK options. */
  options?: Partial<AgentOptions>;
}

export interface StepSpec<T> extends NodeSpecBase {
  /** The work to do. Must be deterministic for caching to be meaningful. */
  run: (ctx: StepContext) => T | Promise<T>;
  /**
   * Extra cache key material. Without it the key is derived from `run.toString()`,
   * which does not capture values the closure captured.
   */
  cache?: boolean | CacheSpec;
}

export interface StepContext {
  runId: string;
  cwd: string;
  signal: AbortSignal;
  log: (message: string) => void;
}

/** Methods every node result exposes, so a child node can be derived from it. */
export interface NodeChain {
  /** Run a shell command that depends on this node. */
  exec(spec: ExecSpec): Promise<ExecResult>;
  /** Run a Claude Code invocation that depends on this node. */
  claude(spec: ClaudeSpec<string>): Promise<ClaudeResult<string>>;
  claude<T>(spec: ClaudeSpec<T> & { output: OutputSchema<T> }): Promise<ClaudeResult<T>>;
  /** Run arbitrary code as a tracked node that depends on this node. */
  step<T>(spec: StepSpec<T>): Promise<StepResult<T>>;
}

export interface NodeResultBase extends NodeChain {
  readonly node: NodeInfo;
}

export interface ExecResult extends NodeResultBase {
  readonly command: string;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  /** stdout, trimmed. */
  readonly text: string;
  readonly ok: boolean;
}

export interface ClaudeUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

export interface ClaudeResult<T = string> extends NodeResultBase {
  /** The final assistant text. */
  readonly text: string;
  /** Validated structured output when `output` was given, else the text. */
  readonly output: T;
  readonly sessionId: string;
  readonly numTurns: number;
  /** Reported cost. Informational on a subscription. */
  readonly costUsd: number;
  readonly usage: ClaudeUsage;
  readonly model: string | undefined;
}

export interface StepResult<T> extends NodeResultBase {
  readonly value: T;
}

export type AnyNodeResult = ExecResult | ClaudeResult<unknown> | StepResult<unknown>;

export interface GraphEdge {
  from: string;
  to: string;
}

export interface RunGraph {
  nodes: NodeInfo[];
  edges: GraphEdge[];
}

export interface RunSummary {
  runId: string;
  pipeline: string;
  startedAt: number;
  durationMs: number;
  ok: boolean;
  /** Total reported Claude cost across the run. */
  costUsd: number;
  nodes: NodeInfo[];
  graph: RunGraph;
}

export interface RunResult<T> extends RunSummary {
  ok: true;
  value: T;
}

export interface FailedRunResult extends RunSummary {
  ok: false;
  error: Error;
}

export type PipelineEvent =
  | { type: 'run:start'; runId: string; pipeline: string; input: unknown }
  | { type: 'run:end'; summary: RunSummary }
  | { type: 'log'; message: string }
  | { type: 'node:start'; node: NodeInfo }
  | { type: 'node:log'; node: NodeInfo; stream: 'stdout' | 'stderr' | 'log'; message: string }
  | { type: 'node:tool'; node: NodeInfo; tool: string; input: unknown }
  | { type: 'node:message'; node: NodeInfo; text: string }
  | { type: 'node:retry'; node: NodeInfo; attempt: number; error: string }
  | { type: 'node:end'; node: NodeInfo; result: unknown };

export type EventListener = (event: PipelineEvent) => void;
