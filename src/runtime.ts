import { randomUUID } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import { CacheStore } from './cache.ts';
import { NodeError, PipelineDefinitionError } from './errors.ts';
import { hashInputs, sha256, stableStringify } from './hash.ts';
import { Journal, loadJournal, type JournalEntry } from './journal.ts';
import { Limiter } from './limiter.ts';
import { runClaude, type ClaudeDefaults, type ClaudeOutcome } from './runners/claude.ts';
import { runExec, type ExecOutcome } from './runners/exec.ts';
import type {
  CacheSpec,
  ClaudeResult,
  ClaudeSpec,
  EventListener,
  ExecResult,
  ExecSpec,
  GraphEdge,
  NodeChain,
  NodeInfo,
  NodeKind,
  NodeSpecBase,
  PipelineEvent,
  RetrySpec,
  StepResult,
  StepSpec,
} from './types.ts';

export interface RuntimeConfig {
  pipeline: string;
  cwd: string;
  stateDir: string;
  concurrency: { exec: number; claude: number; step: number };
  claudeDefaults: ClaudeDefaults;
  useCache: boolean;
  resumeFrom?: string;
  force: Set<string>;
  listeners: EventListener[];
  signal?: AbortSignal;
}

/**
 * Executes and records the nodes of a single run.
 *
 * Every node goes through the same path — fingerprint, replay/cache lookup,
 * bounded execution with retries, journal — regardless of whether it is a shell
 * command, a Claude invocation or a plain function.
 */
export class Runtime {
  readonly runId = randomUUID();
  readonly startedAt = Date.now();
  readonly nodes = new Map<string, NodeInfo>();
  readonly edges: GraphEdge[] = [];

  private readonly cache: CacheStore;
  private readonly journal: Journal;
  private replayable = new Map<string, JournalEntry>();
  private readonly limiters: Record<NodeKind, Limiter>;
  private readonly controller = new AbortController();
  costUsd = 0;

  constructor(readonly config: RuntimeConfig) {
    this.cache = new CacheStore(join(config.stateDir, 'cache'));
    this.journal = new Journal(join(config.stateDir, 'runs'), this.runId);
    this.limiters = {
      exec: new Limiter(config.concurrency.exec),
      claude: new Limiter(config.concurrency.claude),
      step: new Limiter(config.concurrency.step),
    };
    config.signal?.addEventListener('abort', () => this.controller.abort(config.signal?.reason), { once: true });
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  async init(): Promise<void> {
    await this.journal.init();
    if (this.config.resumeFrom) {
      this.replayable = await loadJournal(join(this.config.stateDir, 'runs'), this.config.resumeFrom);
    }
  }

  async finish(): Promise<void> {
    this.controller.abort(new Error('run finished'));
  }

  emit(event: PipelineEvent): void {
    for (const listener of this.config.listeners) {
      try {
        listener(event);
      } catch {
        // A misbehaving listener must never take the run down.
      }
    }
  }

  async writeSummary(summary: Parameters<Journal['writeSummary']>[0]): Promise<void> {
    await this.journal.writeSummary(summary);
  }

  /** The chaining surface handed to the run body and to every node result. */
  chain(parents: string[]): NodeChain {
    return {
      exec: (spec) => this.exec(spec, parents),
      claude: ((spec: ClaudeSpec<any>) => this.claude(spec, parents)) as NodeChain['claude'],
      step: (spec) => this.step(spec, parents),
    };
  }

  private exec(spec: ExecSpec, parents: string[]): Promise<ExecResult> {
    return this.execute<ExecOutcome, ExecResult>({
      kind: 'exec',
      spec,
      parents,
      cwd: spec.cwd ?? this.config.cwd,
      keyMaterial: { command: spec.command, cwd: spec.cwd, env: spec.env, stdin: spec.stdin },
      perform: (node) =>
        runExec(spec, {
          cwd: this.config.cwd,
          node,
          signal: this.signal,
          onLog: (stream, message) => this.emit({ type: 'node:log', node, stream, message }),
        }),
      build: (node, outcome) => ({
        ...this.chain([node.name]),
        node,
        command: outcome.command,
        exitCode: outcome.exitCode,
        stdout: outcome.stdout,
        stderr: outcome.stderr,
        text: outcome.stdout.trim(),
        ok: outcome.exitCode === 0,
      }),
    });
  }

  private claude<T>(spec: ClaudeSpec<T>, parents: string[]): Promise<ClaudeResult<T>> {
    return this.execute<ClaudeOutcome<T>, ClaudeResult<T>>({
      kind: 'claude',
      spec,
      parents,
      cwd: spec.cwd ?? this.config.cwd,
      keyMaterial: {
        prompt: spec.prompt,
        skills: spec.skills,
        tools: spec.tools ?? this.config.claudeDefaults.tools,
        allowedTools: spec.allowedTools ?? this.config.claudeDefaults.allowedTools,
        disallowedTools: spec.disallowedTools,
        model: spec.model ?? this.config.claudeDefaults.model,
        maxTurns: spec.maxTurns ?? this.config.claudeDefaults.maxTurns,
        systemPrompt: spec.systemPrompt ?? spec.appendSystemPrompt,
        structured: spec.output !== undefined,
        resume: spec.resume,
        cwd: spec.cwd,
      },
      perform: (node) =>
        runClaude(spec, {
          cwd: this.config.cwd,
          node,
          signal: this.signal,
          defaults: this.config.claudeDefaults,
          onLog: (message) => this.emit({ type: 'node:log', node, stream: 'log', message }),
          onTool: (tool, input) => this.emit({ type: 'node:tool', node, tool, input }),
          onMessage: (text) => this.emit({ type: 'node:message', node, text }),
        }),
      onSuccess: (outcome) => {
        this.costUsd += outcome.costUsd;
      },
      build: (node, outcome) => ({
        ...this.chain([node.name]),
        node,
        text: outcome.text,
        output: outcome.output,
        sessionId: outcome.sessionId,
        numTurns: outcome.numTurns,
        costUsd: outcome.costUsd,
        usage: outcome.usage,
        model: outcome.model,
      }),
    });
  }

  private step<T>(spec: StepSpec<T>, parents: string[]): Promise<StepResult<T>> {
    return this.execute<{ value: T }, StepResult<T>>({
      kind: 'step',
      spec,
      parents,
      cwd: this.config.cwd,
      // The function source is the only thing we can see; values captured by the
      // closure are invisible, which is why `cache.key` exists.
      keyMaterial: { source: spec.run.toString() },
      perform: async (node) => ({
        value: await spec.run({
          runId: this.runId,
          cwd: this.config.cwd,
          signal: this.signal,
          log: (message) => this.emit({ type: 'node:log', node, stream: 'log', message }),
        }),
      }),
      build: (node, outcome) => ({ ...this.chain([node.name]), node, value: outcome.value }),
    });
  }

  private async execute<TOutcome, TResult>(args: {
    kind: NodeKind;
    spec: NodeSpecBase;
    parents: string[];
    cwd: string;
    keyMaterial: unknown;
    perform: (node: NodeInfo) => Promise<TOutcome>;
    build: (node: NodeInfo, outcome: TOutcome) => TResult;
    onSuccess?: (outcome: TOutcome) => void;
  }): Promise<TResult> {
    const { kind, spec, parents } = args;

    if (this.nodes.has(spec.name)) {
      throw new PipelineDefinitionError(
        `duplicate node name "${spec.name}" — names identify nodes in the graph, the journal and the cache, so they must be unique within a run`,
      );
    }

    const cacheSpec = normalizeCache(spec.cache);
    const files = cacheSpec?.inputs?.length ? await hashInputs(args.cwd, cacheSpec.inputs) : undefined;
    const fingerprint = sha256(
      stableStringify({
        kind,
        name: spec.name,
        key: args.keyMaterial,
        extra: cacheSpec?.key,
        version: cacheSpec?.version,
        files,
        parents: parents.map((p) => this.nodes.get(p)?.fingerprint ?? p),
      }),
    );

    const node: NodeInfo = {
      name: spec.name,
      kind,
      fingerprint,
      parents: [...parents],
      status: 'success',
      startedAt: Date.now(),
      durationMs: 0,
      fromCache: false,
      attempts: 0,
    };
    this.nodes.set(spec.name, node);
    for (const parent of parents) this.edges.push({ from: parent, to: spec.name });
    this.emit({ type: 'node:start', node });

    const forced = this.config.force.has(spec.name);

    // 1. Resume: a node that already succeeded in the run being resumed.
    if (!forced) {
      const replayed = this.replayable.get(fingerprint);
      if (replayed) return this.settle(node, 'replayed', replayed.value as TOutcome, args, { record: false });
    }

    // 2. Cross-run cache: only for nodes that opted in.
    const cacheable = this.config.useCache && cacheSpec !== undefined && !forced;
    if (cacheable) {
      const hit = await this.cache.get(fingerprint);
      if (hit) return this.settle(node, 'cached', hit.value as TOutcome, args, { record: true });
    }

    // 3. Actually run it.
    const retry = normalizeRetry(spec.retry);
    let lastError: unknown;
    for (let attempt = 1; attempt <= retry.attempts; attempt += 1) {
      node.attempts = attempt;
      try {
        const outcome = await this.limiters[kind].run(() => args.perform(node));
        args.onSuccess?.(outcome);
        if (cacheable) await this.cache.set(fingerprint, spec.name, kind, outcome);
        return this.settle(node, 'success', outcome, args, { record: true });
      } catch (error) {
        lastError = error;
        const retryable = attempt < retry.attempts && (retry.when?.(error, attempt) ?? true);
        if (!retryable) break;
        this.emit({ type: 'node:retry', node, attempt, error: describe(error) });
        await sleep(retry.backoffMs * 2 ** (attempt - 1));
      }
    }

    node.status = 'failed';
    node.durationMs = Date.now() - node.startedAt;
    node.error = describe(lastError);
    await this.journal.append({
      fingerprint,
      name: spec.name,
      status: 'failed',
      at: new Date().toISOString(),
      durationMs: node.durationMs,
      error: node.error,
    });
    this.emit({ type: 'node:end', node, result: undefined });
    throw lastError instanceof Error ? lastError : new NodeError(node, describe(lastError), lastError);
  }

  private async settle<TOutcome, TResult>(
    node: NodeInfo,
    status: NodeInfo['status'],
    outcome: TOutcome,
    args: { build: (node: NodeInfo, outcome: TOutcome) => TResult },
    opts: { record: boolean },
  ): Promise<TResult> {
    node.status = status;
    node.fromCache = status !== 'success';
    node.durationMs = Date.now() - node.startedAt;
    const result = args.build(node, outcome);
    await this.journal.append({
      fingerprint: node.fingerprint,
      name: node.name,
      status,
      at: new Date().toISOString(),
      durationMs: node.durationMs,
      // Replays are already recorded in the run being resumed; re-storing the
      // value would double the journal size for no benefit.
      value: opts.record ? outcome : undefined,
    });
    this.emit({ type: 'node:end', node, result });
    return result;
  }
}

function normalizeCache(cache: boolean | CacheSpec | undefined): CacheSpec | undefined {
  if (cache === undefined || cache === false) return undefined;
  if (cache === true) return {};
  return cache;
}

function normalizeRetry(retry: number | RetrySpec | undefined): Required<Pick<RetrySpec, 'attempts' | 'backoffMs'>> & Pick<RetrySpec, 'when'> {
  if (retry === undefined) return { attempts: 1, backoffMs: 500 };
  if (typeof retry === 'number') return { attempts: Math.max(1, retry), backoffMs: 500 };
  return { attempts: Math.max(1, retry.attempts), backoffMs: retry.backoffMs ?? 500, when: retry.when };
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function resolveStateDir(cwd: string, dir: string): string {
  return isAbsolute(dir) ? dir : join(cwd, dir);
}
