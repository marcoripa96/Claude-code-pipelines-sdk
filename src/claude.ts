import {
  query,
  type McpServerConfig,
  type Options,
  type SDKMessage,
  type SDKResultMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type { Schema, StepOptionsBase, StepRecord } from './types.ts';

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

/** One `query()` against the Agent SDK, as the runner asks for it. */
export interface ClaudeRequest {
  /** The run this session belongs to. */
  runId: string;
  /** The step record this session belongs to. A retried step keeps the same id. */
  stepId: string;
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


/**
 * The default Claude runner: one `query()` per step, always a fresh session.
 *
 * Structured Output is the SDK's own `outputFormat`, read back off the result
 * message's `structured_output` — see ADR 0002. The SDK carries its own retry loop
 * inside that; `retry` on the step wraps whole sessions around it.
 */
export interface ClaudeRunnerDeps {
  /** The Agent SDK's `query`. Injectable so the runner's own edges are testable. */
  query?: typeof query;
}

export function createClaudeRunner(deps: ClaudeRunnerDeps = {}): ClaudeRunner {
  const runQuery = deps.query ?? query;
  return async function runClaude(
    request: ClaudeRequest,
    onMessage: (message: SDKMessage) => void,
  ): Promise<ClaudeResponse> {
    const options: Options = {
      cwd: request.cwd,
      permissionMode: request.permissionMode,
      skills: request.skills,
      settingSources: request.settingSources,
    };
    if (request.model !== undefined) options.model = request.model;
    if (request.maxTurns !== undefined) options.maxTurns = request.maxTurns;
    if (request.allowedTools !== undefined) options.allowedTools = request.allowedTools;
    if (request.disallowedTools !== undefined) options.disallowedTools = request.disallowedTools;
    if (request.mcpServers !== undefined) {
      options.mcpServers = request.mcpServers as Record<string, McpServerConfig>;
    }
    if (request.permissionMode === 'bypassPermissions') {
      options.allowDangerouslySkipPermissions = true;
    }
    if (request.jsonSchema) {
      options.outputFormat = { type: 'json_schema', schema: request.jsonSchema };
    }
    // Tracked so it can come off again: a run's signal outlives each of its steps,
    // and a pipeline of many Claude steps would otherwise pile listeners onto it.
    let detach: (() => void) | undefined;
    if (request.signal) {
      const signal = request.signal;
      const controller = new AbortController();
      const abort = () => controller.abort();
      signal.addEventListener('abort', abort, { once: true });
      detach = () => signal.removeEventListener('abort', abort);
      if (signal.aborted) controller.abort();
      options.abortController = controller;
    }

    let result: SDKResultMessage | undefined;
    try {
      for await (const message of runQuery({ prompt: request.prompt, options })) {
        onMessage(message);
        if (message.type === 'result') result = message;
      }
    } finally {
      detach?.();
    }

    if (!result) {
      throw new Error(`Session for step "${request.stepName}" ended without a result message`);
    }
    if (result.subtype !== 'success' || result.is_error) {
      throw new Error(describeFailure(request.stepName, result));
    }

    return {
      text: result.result,
      structuredOutput: result.structured_output,
      sessionId: result.session_id,
      totalCostUsd: result.total_cost_usd,
    };
  };
}

function describeFailure(stepName: string, result: SDKResultMessage): string {
  const parts = [`Session for step "${stepName}" ended as ${result.subtype}`];
  if (result.terminal_reason) parts.push(`(${result.terminal_reason})`);
  const errors = 'errors' in result ? result.errors : undefined;
  if (errors?.length) parts.push(`: ${errors.join('; ')}`);
  else if (result.subtype === 'success') parts.push(`: ${result.result}`);
  return parts.join(' ');
}
