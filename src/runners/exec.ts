import { spawn } from 'node:child_process';
import { ExecError, TimeoutError } from '../errors.ts';
import type { ExecSpec, NodeInfo } from '../types.ts';

export interface ExecOutcome {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
}

export async function runExec(
  spec: ExecSpec,
  ctx: { cwd: string; node: NodeInfo; signal: AbortSignal; onLog: (stream: 'stdout' | 'stderr', line: string) => void },
): Promise<ExecOutcome> {
  const cwd = spec.cwd ?? ctx.cwd;
  const env = { ...process.env, ...spec.env };
  const stream = spec.stream !== false;

  const outcome = await new Promise<ExecOutcome>((resolve, reject) => {
    const child = spawn(spec.command, {
      cwd,
      env: env as NodeJS.ProcessEnv,
      shell: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      signal: ctx.signal,
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer =
      spec.timeout !== undefined
        ? setTimeout(() => {
            child.kill('SIGKILL');
            if (!settled) {
              settled = true;
              reject(new TimeoutError(spec.timeout!));
            }
          }, spec.timeout)
        : undefined;

    const collect = (which: 'stdout' | 'stderr') => (chunk: Buffer) => {
      const text = chunk.toString();
      if (which === 'stdout') stdout += text;
      else stderr += text;
      if (stream) for (const line of text.split('\n')) if (line.trim()) ctx.onLog(which, line);
    };

    child.stdout?.on('data', collect('stdout'));
    child.stderr?.on('data', collect('stderr'));

    if (spec.stdin !== undefined) child.stdin?.end(spec.stdin);
    else child.stdin?.end();

    child.on('error', (error) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        reject(error);
      }
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        resolve({ command: spec.command, exitCode: code ?? -1, stdout, stderr });
      }
    });
  });

  if (outcome.exitCode !== 0 && !spec.allowFailure) {
    throw new ExecError(ctx.node, outcome.exitCode, outcome.stdout, outcome.stderr);
  }
  return outcome;
}
