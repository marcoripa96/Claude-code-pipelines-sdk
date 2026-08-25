import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { ClaudeRequest, ClaudeResponse, ClaudeRunner } from './types.ts';

const SESSION = Symbol.for('claude-code-pipelines-sdk.fakeSession');

interface FakeSession {
  [SESSION]: true;
  output?: unknown;
  text?: string;
  sessionId?: string;
  messages?: SDKMessage[];
}

/**
 * One stand-in session. A plain object is the step's Output, a string is its final
 * text, an `Error` is a session that failed, and `session()` sets several at once.
 */
export type Fixture =
  | Record<string, unknown>
  | string
  | Error
  | FakeSession
  | ((request: ClaudeRequest) => Fixture | Promise<Fixture>);

/** An array is consumed one entry per attempt, so `retry` can be exercised. */
export type StepFixture = Fixture | Fixture[];

export interface FakeRunner extends ClaudeRunner {
  /** Every request the pipeline made, in order. */
  readonly calls: ClaudeRequest[];
}

/** Spells out a stand-in session when the Output alone is not enough. */
export function session(parts: {
  output?: unknown;
  text?: string;
  sessionId?: string;
  messages?: SDKMessage[];
}): FakeSession {
  return { [SESSION]: true, ...parts };
}

/**
 * Substitutes fixture Outputs for real sessions, keyed by step name, so a pipeline's
 * branches are assertable without an API call.
 *
 * Fixtures still go through the step's Output schema: one that does not satisfy it
 * fails the step exactly as a real session's answer would.
 */
export function fake(fixtures: Record<string, StepFixture>): FakeRunner {
  const calls: ClaudeRequest[] = [];
  const attempts = new Map<string, number>();

  const runner = (async (request, onMessage) => {
    calls.push(request);

    if (!(request.stepName in fixtures)) {
      const known = Object.keys(fixtures);
      throw new Error(
        `fake() has no fixture for step "${request.stepName}"` +
          (known.length ? ` (has: ${known.join(', ')})` : ''),
      );
    }

    const declared = fixtures[request.stepName]!;
    const attempt = attempts.get(request.stepName) ?? 0;
    attempts.set(request.stepName, attempt + 1);

    let fixture: Fixture;
    if (Array.isArray(declared)) {
      if (declared.length === 0) {
        throw new Error(`fake() fixture for step "${request.stepName}" is an empty list`);
      }
      fixture = declared[Math.min(attempt, declared.length - 1)]!;
    } else {
      fixture = declared;
    }

    while (typeof fixture === 'function') fixture = await fixture(request);
    if (fixture instanceof Error) throw fixture;

    const parts = isSession(fixture)
      ? fixture
      : typeof fixture === 'string'
        ? { text: fixture }
        : { output: fixture };

    for (const message of ('messages' in parts && parts.messages) || []) onMessage(message);

    return {
      text: parts.text ?? (parts.output === undefined ? '' : JSON.stringify(parts.output)),
      structuredOutput: parts.output,
      sessionId: 'sessionId' in parts ? parts.sessionId : `fake-${request.stepName}`,
    } satisfies ClaudeResponse;
  }) as ClaudeRunner;

  return Object.assign(runner, { calls }) as FakeRunner;
}

function isSession(value: Fixture): value is FakeSession {
  return typeof value === 'object' && value !== null && SESSION in value;
}
