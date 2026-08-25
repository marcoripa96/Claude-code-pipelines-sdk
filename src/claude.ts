import {
  query,
  type McpServerConfig,
  type Options,
  type SDKMessage,
  type SDKResultMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type { ClaudeRequest, ClaudeResponse, ClaudeRunner } from './types.ts';

/**
 * The default Claude runner: one `query()` per step, always a fresh session.
 *
 * Structured Output is the SDK's own `outputFormat`, read back off the result
 * message's `structured_output` — see ADR 0002. The SDK carries its own retry loop
 * inside that; `retry` on the step wraps whole sessions around it.
 */
export function createClaudeRunner(): ClaudeRunner {
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
    if (request.signal) {
      const controller = new AbortController();
      request.signal.addEventListener('abort', () => controller.abort(), { once: true });
      if (request.signal.aborted) controller.abort();
      options.abortController = controller;
    }

    let result: SDKResultMessage | undefined;
    for await (const message of query({ prompt: request.prompt, options })) {
      onMessage(message);
      if (message.type === 'result') result = message;
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
