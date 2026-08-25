import { query, type Options as AgentOptions, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { NodeError, TimeoutError } from '../errors.ts';
import { toJsonSchema, validateOutput } from '../schema.ts';
import type { ClaudeSpec, ClaudeUsage, NodeInfo } from '../types.ts';

export interface ClaudeOutcome<T> {
  text: string;
  output: T;
  sessionId: string;
  numTurns: number;
  costUsd: number;
  usage: ClaudeUsage;
  model: string | undefined;
}

export interface ClaudeDefaults {
  model?: string;
  tools?: AgentOptions['tools'];
  allowedTools?: string[];
  permissionMode?: AgentOptions['permissionMode'];
  settingSources?: AgentOptions['settingSources'];
  systemPrompt?: AgentOptions['systemPrompt'];
  env?: Record<string, string | undefined>;
  maxTurns?: number;
}

/**
 * Run one Claude Code invocation to completion and return its result.
 *
 * The invocation is headless: `permissionMode` defaults to `'dontAsk'`, so a
 * tool the pipeline did not allow is denied rather than blocking on a prompt
 * that no one is there to answer.
 */
export async function runClaude<T>(
  spec: ClaudeSpec<T>,
  ctx: {
    cwd: string;
    node: NodeInfo;
    signal: AbortSignal;
    defaults: ClaudeDefaults;
    onLog: (message: string) => void;
    onTool: (tool: string, input: unknown) => void;
    onMessage: (text: string) => void;
  },
): Promise<ClaudeOutcome<T>> {
  const abort = new AbortController();
  const forward = () => abort.abort();
  ctx.signal.addEventListener('abort', forward, { once: true });

  const timer =
    spec.timeout !== undefined
      ? setTimeout(() => abort.abort(new TimeoutError(spec.timeout!)), spec.timeout)
      : undefined;

  const options: AgentOptions = {
    cwd: spec.cwd ?? ctx.cwd,
    abortController: abort,
    model: spec.model ?? ctx.defaults.model,
    fallbackModel: spec.fallbackModel,
    maxTurns: spec.maxTurns ?? ctx.defaults.maxTurns,
    permissionMode: spec.permissionMode ?? ctx.defaults.permissionMode ?? 'dontAsk',
    settingSources: spec.settingSources ?? ctx.defaults.settingSources ?? ['project'],
    systemPrompt: resolveSystemPrompt(spec, ctx.defaults),
    tools: spec.tools ?? ctx.defaults.tools,
    allowedTools: spec.allowedTools ?? ctx.defaults.allowedTools,
    disallowedTools: spec.disallowedTools,
    skills: spec.skills,
    mcpServers: spec.mcpServers,
    agents: spec.agents,
    resume: spec.resume,
    ...(spec.allowDangerouslySkipPermissions ? { allowDangerouslySkipPermissions: true } : {}),
    ...(spec.env || ctx.defaults.env ? { env: { ...process.env, ...ctx.defaults.env, ...spec.env } } : {}),
    ...(spec.output ? { outputFormat: { type: 'json_schema', schema: await toJsonSchema(spec.output) } } : {}),
    ...spec.options,
  };

  let text = '';
  let sessionId = '';
  let numTurns = 0;
  let costUsd = 0;
  let model: string | undefined;
  let structured: unknown;
  let usage: ClaudeUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
  let failure: string | undefined;

  try {
    for await (const message of query({ prompt: spec.prompt, options }) as AsyncIterable<SDKMessage>) {
      switch (message.type) {
        case 'system': {
          if ('session_id' in message && message.session_id) sessionId = message.session_id;
          break;
        }
        case 'assistant': {
          model ??= message.message.model;
          for (const block of message.message.content) {
            if (block.type === 'text' && block.text.trim()) ctx.onMessage(block.text);
            else if (block.type === 'tool_use') ctx.onTool(block.name, block.input);
          }
          break;
        }
        case 'result': {
          sessionId = message.session_id || sessionId;
          numTurns = message.num_turns;
          costUsd = message.total_cost_usd ?? 0;
          usage = normalizeUsage(message.usage);
          if (message.subtype === 'success') {
            text = message.result;
            structured = message.structured_output;
          } else {
            failure = `${message.subtype}${'result' in message && message.result ? `: ${message.result}` : ''}`;
          }
          break;
        }
        default:
          break;
      }
    }
  } finally {
    clearTimeout(timer);
    ctx.signal.removeEventListener('abort', forward);
  }

  if (failure) throw new NodeError(ctx.node, failure);
  if (abort.signal.aborted) throw abort.signal.reason ?? new NodeError(ctx.node, 'aborted');

  const output = spec.output
    ? await validateOutput(spec.output, structured ?? parseLooseJson(text)).catch((error: unknown) => {
        throw new NodeError(ctx.node, error instanceof Error ? error.message : String(error), error);
      })
    : (text as unknown as T);

  return { text, output, sessionId, numTurns, costUsd, usage, model };
}

function resolveSystemPrompt(spec: ClaudeSpec<unknown>, defaults: ClaudeDefaults): AgentOptions['systemPrompt'] {
  if (spec.systemPrompt !== undefined) return spec.systemPrompt;
  if (spec.appendSystemPrompt !== undefined) {
    return { type: 'preset', preset: 'claude_code', append: spec.appendSystemPrompt };
  }
  return defaults.systemPrompt;
}

function normalizeUsage(usage: unknown): ClaudeUsage {
  const u = (usage ?? {}) as Record<string, number | undefined>;
  return {
    inputTokens: u.input_tokens ?? 0,
    outputTokens: u.output_tokens ?? 0,
    cacheReadTokens: u.cache_read_input_tokens ?? 0,
    cacheCreationTokens: u.cache_creation_input_tokens ?? 0,
  };
}

/**
 * Last-resort parse for the case where the CLI returned no structured output
 * attachment: pull the first JSON object or array out of the final text.
 */
function parseLooseJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const candidates = [fenced?.[1], text];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const trimmed = candidate.trim();
    try {
      return JSON.parse(trimmed);
    } catch {
      const start = trimmed.search(/[[{]/);
      const end = Math.max(trimmed.lastIndexOf('}'), trimmed.lastIndexOf(']'));
      if (start !== -1 && end > start) {
        try {
          return JSON.parse(trimmed.slice(start, end + 1));
        } catch {
          // fall through to the next candidate
        }
      }
    }
  }
  return undefined;
}
