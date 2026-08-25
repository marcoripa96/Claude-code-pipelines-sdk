import type { NodeInfo } from './types.ts';

/** Thrown when a node fails (after retries) and the failure is not tolerated. */
export class NodeError extends Error {
  readonly node: NodeInfo;
  override readonly cause?: unknown;

  constructor(node: NodeInfo, message: string, cause?: unknown) {
    super(`[${node.kind}:${node.name}] ${message}`);
    this.name = 'NodeError';
    this.node = node;
    this.cause = cause;
  }
}

/** Thrown when a shell command exits non-zero and `allowFailure` is not set. */
export class ExecError extends NodeError {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;

  constructor(node: NodeInfo, exitCode: number, stdout: string, stderr: string) {
    const tail = stderr.trim() || stdout.trim();
    super(node, `exited with code ${exitCode}${tail ? `\n${indent(lastLines(tail, 20))}` : ''}`);
    this.name = 'ExecError';
    this.exitCode = exitCode;
    this.stdout = stdout;
    this.stderr = stderr;
  }
}

/** Thrown when the pipeline definition itself is wrong (duplicate names, bad config). */
export class PipelineDefinitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PipelineDefinitionError';
  }
}

/** Thrown when a node times out. */
export class TimeoutError extends Error {
  constructor(ms: number) {
    super(`timed out after ${ms}ms`);
    this.name = 'TimeoutError';
  }
}

function lastLines(text: string, n: number): string {
  const lines = text.split('\n');
  return lines.length <= n ? text : lines.slice(-n).join('\n');
}

function indent(text: string): string {
  return text
    .split('\n')
    .map((l) => `  │ ${l}`)
    .join('\n');
}
