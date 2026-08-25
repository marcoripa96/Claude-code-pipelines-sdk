import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

/**
 * Structural view of a Zod schema. Declared structurally so the SDK's own types
 * do not depend on a particular Zod build; `zod` v4 is a peer dependency and its
 * schemas satisfy this shape.
 */
export interface Schema<T = unknown> {
  parse(data: unknown): T;
}

export type Infer<S> = S extends Schema<infer T> ? T : never;

/** How a step did its work. */
export type StepKind = 'claude' | 'command' | 'code';

/**
 * `skipped` is reserved for steps a halt stopped the run from reaching; a branch
 * simply not taken produces no record at all.
 */
export type StepStatus = 'running' | 'completed' | 'failed' | 'skipped';

export type RunStatus = 'running' | 'completed' | 'halted' | 'failed';

/** What a run wrote about one step. Handed to the storage adapter and to `on` events. */
export interface StepRecord {
  id: string;
  runId: string;
  /** Position in the run, in execution order. `-1` for steps recorded as skipped. */
  index: number;
  name: string;
  kind: StepKind;
  status: StepStatus;
  startedAt: number;
  finishedAt?: number;
  durationMs?: number;
  /** The schema-validated Output of a Claude step, or a command/code step's value. */
  output?: unknown;
  /** Final assistant text of a Claude step. */
  text?: string;
  error?: string;
  exitCode?: number;
  sessionId?: string;
  /** How many attempts the step took, including the successful one. */
  attempts?: number;
  cacheKey?: string;
  cacheHit?: boolean;
}

/** What a run wrote about itself. */
export interface RunRecord {
  id: string;
  pipeline: string;
  status: RunStatus;
  workspace: string;
  input: unknown;
  model?: string;
  startedAt: number;
  finishedAt?: number;
  durationMs?: number;
  /** The value the pipeline's `run` returned. Absent when halted or failed. */
  output?: unknown;
  haltReason?: string;
  error?: string;
}

/** A finished run: its record plus every step record, in order. */
export interface RunResult<O = unknown> extends RunRecord {
  output?: O;
  steps: StepRecord[];
  /** The error that failed the run, unserialised. Absent unless `status` is `failed`. */
  cause?: unknown;
}

/**
 * Live progress. The application watching a run is the process running it, so it
 * subscribes here rather than reading the store.
 *
 * A listener that throws does not fail the run; the error is reported to `error`
 * if one is supplied, and otherwise written to stderr.
 */
export interface RunEvents {
  runStarted?(run: RunRecord): void | Promise<void>;
  stepStarted?(step: StepRecord): void | Promise<void>;
  /** Claude's `SDKMessage`, verbatim, with the step that produced it. */
  message?(message: SDKMessage, step: StepRecord): void | Promise<void>;
  stepFinished?(step: StepRecord): void | Promise<void>;
  runFinished?(run: RunResult): void | Promise<void>;
  /** Reports a listener that threw. */
  error?(error: unknown): void;
}

/**
 * A write-only sink for a run's history. It never reads and the SDK never deletes:
 * retention belongs to whoever implements this.
 */
export interface StorageAdapter {
  runStarted(run: RunRecord): Promise<void> | void;
  stepStarted(step: StepRecord): Promise<void> | void;
  messageAppended(stepId: string, message: SDKMessage): Promise<void> | void;
  stepFinished(step: StepRecord): Promise<void> | void;
  runFinished(run: RunRecord): Promise<void> | void;
  /** Optional teardown, called when a run finishes if the adapter defines it. */
  close?(): Promise<void> | void;
}

/** A small keyed store. Separate from storage because caching must read back what it wrote. */
export interface CacheAdapter {
  get(key: string): Promise<unknown | undefined> | unknown | undefined;
  set(key: string, value: unknown): Promise<void> | void;
}

/** Opt-in caching for one step. Steps are never cacheable by default. */
export interface CacheOptions {
  /**
   * Files whose contents the step depends on, relative to the workspace.
   * Glob patterns are expanded. The key also covers everything in ADR 0006.
   */
  inputs?: string[];
}

/** Options common to every step kind. */
interface StepOptionsBase {
  name?: string;
  cache?: CacheOptions;
}

export interface ClaudeStepOptions<S extends Schema | undefined = undefined>
  extends StepOptionsBase {
  name: string;
  prompt: string;
  /** Declaring a schema turns the session's answer into an Output. */
  output?: S;
  /** Extra attempts on session failure, on top of the first. Default `0`. */
  retry?: number;
  model?: string;
  /** Overrides the run's workspace for this step only. */
  cwd?: string;
  maxTurns?: number;
  allowedTools?: string[];
  disallowedTools?: string[];
  /** Default `'bypassPermissions'`: an unattended pipeline that stops to ask is a hang. */
  permissionMode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan';
  /** Default `'all'`; the prompt says which skill to use. */
  skills?: 'all' | string[];
  /** Default `['project']`, so `CLAUDE.md` and project skills load. */
  settingSources?: ('user' | 'project' | 'local')[];
  mcpServers?: Record<string, unknown>;
}

export interface CommandStepOptions extends StepOptionsBase {
  command: string;
  /** Return the handle instead of throwing when the command exits non-zero. */
  allowFailure?: boolean;
  cwd?: string;
  env?: Record<string, string>;
}

/** What a Claude step returns to pipeline code. */
export interface ClaudeHandle<T = undefined> {
  name: string;
  /** The schema-validated Output. Only present when a schema was declared. */
  output: T;
  /** Final assistant text. The whole answer when no schema was declared. */
  text: string;
  sessionId?: string;
  cacheHit: boolean;
  step: StepRecord;
}

/** What a command step returns to pipeline code. */
export interface CommandHandle {
  name: string;
  stdout: string;
  stderr: string;
  exitCode: number;
  cacheHit: boolean;
  step: StepRecord;
}

/** One `query()` against the Agent SDK, as the runner asks for it. */
export interface ClaudeRequest {
  stepName: string;
  prompt: string;
  /** `z.toJSONSchema(output)` when a schema was declared. */
  jsonSchema?: Record<string, unknown>;
  model?: string;
  cwd: string;
  maxTurns?: number;
  allowedTools?: string[];
  disallowedTools?: string[];
  permissionMode: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan';
  skills: 'all' | string[];
  settingSources: ('user' | 'project' | 'local')[];
  mcpServers?: Record<string, unknown>;
  signal?: AbortSignal;
}

export interface ClaudeResponse {
  text: string;
  /** The value read off the result message's `structured_output`. */
  structuredOutput?: unknown;
  sessionId?: string;
  totalCostUsd?: number;
}

/**
 * Runs one Claude session. Swapped for `fake()` in tests so branch logic is
 * assertable without an API call.
 */
export type ClaudeRunner = (
  request: ClaudeRequest,
  onMessage: (message: SDKMessage) => void,
) => Promise<ClaudeResponse>;
