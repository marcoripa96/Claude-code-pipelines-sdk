import { describe, expect, test } from 'bun:test';
import { fake } from '@marcoripa96/claude-code-pipelines-sdk';
import { createKanbyFactory } from '../examples/kanby-software-factory/pipeline.ts';
import type {
  KanbyTask,
  KanbyFactoryDependencies,
  RiskLevel,
} from '../examples/kanby-software-factory/contracts.ts';

/**
 * The example is imported by package name, so it breaks loudly when the API changes.
 * Its system adapters are replaced with recording fakes and no real session is opened.
 */
describe('the kanby-software-factory example', () => {
  test('takes a backlog task through intake and delivery in one run', async () => {
    const fixture = harness({ status: 'backlog', content: '', outputKeys: [] });
    const claude = fake({
      classify: classification(),
      analyze: analysis(),
      implement: { summary: 'fixed the formatter' },
      review: review(),
    });
    const result = await createKanbyFactory(fixture.dependencies).run({
      input: input('true'),
      claude,
    });

    expect(result.status).toBe('completed');
    expect(result.output).toBeUndefined();
    expect(claude.calls.map((call) => call.stepName)).toEqual([
      'classify',
      'analyze',
      'implement',
      'review',
    ]);
    expect(fixture.effects).toEqual([
      'get',
      'claim',
      'output:Classification',
      'output:Analysis',
      'update:content',
      'move:todo',
      'preflight-git',
      'preflight-gitlab',
      'move:in_progress',
      'output:Implementation',
      'verify-commit',
      'checks:true',
      'output:Checks',
      'output:Review',
      'push:task/42-digest-dates:abc123',
      'ensure-mr:group/project:task/42-digest-dates->main',
      'link-mr:17',
      'move:in_review',
      'release',
    ]);
    expect(fixture.outputs.map((output) => output.key)).toEqual([
      'kanby-software-factory/classification',
      'kanby-software-factory/analysis',
      'kanby-software-factory/implementation',
      'kanby-software-factory/checks',
      'kanby-software-factory/review',
    ]);
    expect(fixture.updatedContent).toContain('Add timezone-aware digest formatting.');
  });

  test('resumes a prepared todo task at implementation, recording intake as skipped', async () => {
    const fixture = harness();
    const claude = fake({
      implement: { summary: 'fixed the formatter' },
      review: review(),
    });
    const result = await createKanbyFactory(fixture.dependencies).run({
      input: input('true'),
      claude,
    });

    expect(result.status).toBe('completed');
    expect(claude.calls.map((call) => call.stepName)).toEqual(['implement', 'review']);
    // A completed run records only the stages it executed; the SDK records steps as
    // skipped when a halt stops a run, not when code branches past a stage.
    for (const name of [
      'classify',
      'publish-classification',
      'analyze',
      'write-brief',
      'move-todo',
    ]) {
      expect(result.steps.find((step) => step.name === name)).toBeUndefined();
    }
    expect(fixture.effects).toEqual([
      'get',
      'claim',
      'preflight-git',
      'preflight-gitlab',
      'move:in_progress',
      'output:Implementation',
      'verify-commit',
      'checks:true',
      'output:Checks',
      'output:Review',
      'push:task/42-digest-dates:abc123',
      'ensure-mr:group/project:task/42-digest-dates->main',
      'link-mr:17',
      'move:in_review',
      'release',
    ]);
  });

  test('refuses todo work without the preparation evidence', async () => {
    const fixture = harness({ outputKeys: [] });
    const result = await createKanbyFactory(fixture.dependencies).run({
      input: input('true'),
      claude: fake({}),
    });

    expect(result.status).toBe('halted');
    expect(result.haltReason).toBe('todo task is missing preparation outputs');
    // Decidable from the fetched snapshot alone, so it never claims and never has
    // to undo a claim.
    expect(fixture.effects).toEqual(['get']);
  });

  test('halts before claiming a task that is already blocked or out of intake', async () => {
    for (const taskOverrides of [
      { blocked: { reason: 'waiting for API details' } },
      { status: 'in_review' as const },
    ]) {
      const fixture = harness(taskOverrides);
      const result = await createKanbyFactory(fixture.dependencies).run({
        input: input('true'),
        claude: fake({}),
      });

      expect(result.status).toBe('halted');
      expect(fixture.effects).toEqual(['get']);
    }
  });

  test('records failed checks and blocks before review', async () => {
    const fixture = harness();
    const claude = fake({ implement: { summary: 'fixed the formatter' } });
    const result = await createKanbyFactory(fixture.dependencies).run({
      input: input('false'),
      claude,
    });

    expect(result.status).toBe('halted');
    expect(result.haltReason).toBe('Check command exited 1: false');
    expect(fixture.outputs.find((output) => output.title === 'Checks')?.body).toContain(
      'Exit code: `1`',
    );
    expect(claude.calls.map((call) => call.stepName)).toEqual(['implement']);
    // The handoff ritual is two recorded steps: record why, then free the card.
    expect(
      result.steps
        .filter((step) => step.name.startsWith('handoff'))
        .map((step) => `${step.name}:${step.status}`),
    ).toEqual(['handoff-block:completed', 'handoff-release:completed']);
    expect(fixture.effects).toContain('block:Check command exited 1: false');
    expect(fixture.effects.at(-1)).toBe('release');
    expect(fixture.effects).not.toContain('push:task/42-digest-dates:abc123');
  });

  test('revises once and publishes when the second review approves', async () => {
    const fixture = harness();
    const claude = fake({
      implement: { summary: 'fixed the formatter' },
      'implement-2': { summary: 'addressed the review concerns' },
      review: review({ concerns: ['no test covers the DST boundary'] }),
      'review-2': review(),
    });
    const result = await createKanbyFactory(fixture.dependencies).run({
      input: input('true'),
      claude,
    });

    expect(result.status).toBe('completed');
    expect(claude.calls.map((call) => call.stepName)).toEqual([
      'implement',
      'review',
      'implement-2',
      'review-2',
    ]);
    expect(fixture.effects).toEqual([
      'get',
      'claim',
      'preflight-git',
      'preflight-gitlab',
      'move:in_progress',
      'output:Implementation',
      'verify-commit',
      'checks:true',
      'output:Checks',
      'output:Review',
      'output:Implementation',
      'verify-commit',
      'checks:true',
      'output:Checks',
      'output:Review',
      'push:task/42-digest-dates:abc123',
      'ensure-mr:group/project:task/42-digest-dates->main',
      'link-mr:17',
      'move:in_review',
      'release',
    ]);
  });

  test('blocks when the concerns survive every revision round', async () => {
    const fixture = harness();
    const claude = fake({
      implement: { summary: 'fixed the formatter' },
      'implement-2': { summary: 'tried to address the concerns' },
      review: review({ concerns: ['no test covers the DST boundary'] }),
      'review-2': review({ completeness: 'partial' }),
    });
    const result = await createKanbyFactory(fixture.dependencies).run({
      input: input('true'),
      claude,
    });

    expect(result.status).toBe('halted');
    expect(result.haltReason).toBe('Implementation is partial');
    expect(claude.calls.map((call) => call.stepName)).toEqual([
      'implement',
      'review',
      'implement-2',
      'review-2',
    ]);
    expect(fixture.effects).toContain('block:Implementation is partial');
    expect(fixture.effects.at(-1)).toBe('release');
    expect(fixture.effects).not.toContain('push:task/42-digest-dates:abc123');
  });

  test('blocks immediately when revisions are disabled', async () => {
    const fixture = harness();
    const claude = fake({
      implement: { summary: 'fixed the formatter' },
      review: review({ concerns: ['no test covers the DST boundary'] }),
    });
    const result = await createKanbyFactory(fixture.dependencies).run({
      input: input('true', 0),
      claude,
    });

    expect(result.status).toBe('halted');
    expect(result.haltReason).toBe('no test covers the DST boundary');
    expect(claude.calls.map((call) => call.stepName)).toEqual(['implement', 'review']);
    expect(fixture.effects).toContain('block:no test covers the DST boundary');
    expect(fixture.effects.at(-1)).toBe('release');
    expect(fixture.effects).not.toContain('push:task/42-digest-dates:abc123');
  });

  test('leaves low-confidence classification blocked in backlog', async () => {
    const fixture = harness({ status: 'backlog', content: '', outputKeys: [] });
    const result = await createKanbyFactory(fixture.dependencies).run({
      input: input('true'),
      claude: fake({ classify: classification({ confidence: 0.5 }) }),
    });

    expect(result.status).toBe('halted');
    expect(result.haltReason).toBe(
      'Classification confidence is 0.5: Matches a feature request.',
    );
    expect(fixture.effects).toContain(
      'block:Classification confidence is 0.5: Matches a feature request.',
    );
    expect(fixture.effects.at(-1)).toBe('release');
    expect(fixture.effects).not.toContain('move:todo');
    expect(fixture.effects).not.toContain('preflight-git');
  });

  test('records the revision round in every step of the loop', async () => {
    const fixture = harness();
    const claude = fake({
      implement: { summary: 'fixed the formatter' },
      'implement-2': { summary: 'addressed the review concerns' },
      review: review({ concerns: ['no test covers the DST boundary'] }),
      'review-2': review(),
    });
    const result = await createKanbyFactory(fixture.dependencies).run({
      input: input('true'),
      claude,
    });

    expect(result.status).toBe('completed');
    // Seven steps per round, each named for its round: a two-round run reads as
    // fourteen records rather than seven names appearing twice.
    expect(
      result.steps.filter((step) => step.name.endsWith('-2')).map((step) => step.name),
    ).toEqual([
      'implement-2',
      'publish-implementation-2',
      'verify-commit-2',
      'check-2',
      'publish-checks-2',
      'review-2',
      'publish-review-2',
    ]);
    expect(fixture.outputs.filter((output) => output.title === 'Review').at(-1)?.body).toContain(
      '**Revision round 2**',
    );
  });

  test('hands a change over when its risk is above the unattended ceiling', async () => {
    const fixture = harness();
    const result = await createKanbyFactory(fixture.dependencies).run({
      input: input('true'),
      claude: fake({
        implement: { summary: 'fixed the formatter' },
        review: review({ compatibilityRisk: 'high' }),
      }),
    });

    // The review is complete and raises no concerns; risk alone stopped it.
    expect(result.status).toBe('halted');
    expect(result.haltReason).toBe(
      'Compatibility risk is high, above the unattended ceiling medium: ' +
      'a human decides before this is published',
    );
    expect(fixture.outputs.find((output) => output.title === 'Review')?.body).toContain(
      '**Suggested review depth:** deep review',
    );
    expect(fixture.effects.at(-1)).toBe('release');
    expect(fixture.effects).not.toContain('push:task/42-digest-dates:abc123');
  });

  test('publishes the same change when the ceiling is raised to high', async () => {
    const fixture = harness();
    const result = await createKanbyFactory(fixture.dependencies).run({
      input: input('true', 1, { maxUnattendedRisk: 'high' }),
      claude: fake({
        implement: { summary: 'fixed the formatter' },
        review: review({ compatibilityRisk: 'high' }),
      }),
    });

    expect(result.status).toBe('completed');
    expect(fixture.effects).toContain('push:task/42-digest-dates:abc123');
  });

  test('reviews a change of any size when no ceiling is set, and gates one when it is', async () => {
    const big = () => {
      const fixture = harness();
      fixture.dependencies.repository.verifyCommit = async () => ({
        sha: 'abc123',
        base: 'base000',
        commits: 1,
        diffBytes: 900_000,
      });
      return fixture;
    };

    const uncapped = big();
    const reviewed = await createKanbyFactory(uncapped.dependencies).run({
      input: input('true'),
      claude: fake({ implement: { summary: 'big change' }, review: review({}) }),
    });

    // No ceiling means no gate: a large change is reviewed like any other.
    expect(reviewed.status).toBe('completed');
    expect(uncapped.effects).toContain('push:task/42-digest-dates:abc123');

    const capped = big();
    const stopped = await createKanbyFactory(capped.dependencies).run({
      input: input('true', 1, { maxDiffBytes: 1_000 }),
      claude: fake({ implement: { summary: 'big change' }, review: review({}) }),
    });

    expect(stopped.status).toBe('halted');
    expect(stopped.haltReason).toContain('900000 bytes, larger than 1000');
    expect(capped.effects).not.toContain('push:task/42-digest-dates:abc123');
    // Stopping still releases the card, like every other way this pipeline stops.
    expect(capped.effects.at(-1)).toBe('release');
  });

  test('blocks and releases the card when a step throws', async () => {
    const fixture = harness();
    fixture.dependencies.repository.preflight = async () => {
      throw new Error('workspace must be clean before the task run starts');
    };

    const result = await createKanbyFactory(fixture.dependencies).run({
      input: input('true'),
      claude: fake({}),
    });

    // A failure is still a failure — but it never leaves the card claimed by an
    // agent that is gone.
    expect(result.status).toBe('failed');
    expect(result.error).toContain('workspace must be clean');
    expect(fixture.effects).toEqual([
      'get',
      'claim',
      'block:Run failed: Step "preflight-git" failed: ' +
      'workspace must be clean before the task run starts',
      'release',
    ]);
  });

  test('carries the classification type into the brief the implementer reads', async () => {
    const fixture = harness({ status: 'backlog', content: '', outputKeys: [] });
    await createKanbyFactory(fixture.dependencies).run({
      input: input('true'),
      claude: fake({
        classify: classification({ type: 'bug' }),
        analyze: analysis(),
        implement: { summary: 'fixed the formatter' },
        review: review(),
      }),
    });

    expect(fixture.updatedContent).toContain('**Task type:** bug');
  });
});

function input(
  testCommand: string,
  maxRevisions = 1,
  overrides: {
    maxUnattendedRisk?: 'none' | 'low' | 'medium' | 'high';
    maxDiffBytes?: number;
  } = {},
) {
  return {
    taskGuid: '019f-task',
    testCommand,
    maxRevisions,
    ...overrides,
    gitlab: {
      host: 'https://gitlab.example.internal',
      project: 'group/project',
      sourceBranch: 'task/42-digest-dates',
      targetBranch: 'main',
    },
  };
}

function classification(overrides: Partial<ReturnType<typeof classificationDefaults>> = {}) {
  return { ...classificationDefaults(), ...overrides };
}

function classificationDefaults() {
  return {
    type: 'feature' as 'bug' | 'feature' | 'documentation' | 'chore',
    confidence: 0.95,
    rationale: 'Matches a feature request.',
    requiresHumanTriage: false,
  };
}

function analysis(overrides: Partial<ReturnType<typeof analysisDefaults>> = {}) {
  return { ...analysisDefaults(), ...overrides };
}

function analysisDefaults() {
  return {
    ready: true,
    reason: 'The formatter is reachable and the change is compatible.',
    evidence: ['The current formatter always uses UTC.'],
    specification: 'Add timezone-aware digest formatting.',
    plan: ['Read the recipient timezone.', 'Format the digest date in that timezone.'],
    compatibility: 'The existing UTC fallback remains unchanged.',
    risk: 'low' as const,
    requiredChecks: ['Run digest formatter tests.'],
  };
}

function review(overrides: Partial<ReturnType<typeof reviewDefaults>> = {}) {
  return { ...reviewDefaults(), ...overrides };
}

function reviewDefaults() {
  return {
    summary: 'Ready for human review.',
    completeness: 'complete' as 'complete' | 'partial' | 'missing',
    concerns: [] as string[],
    sideEffectRisk: 'low' as RiskLevel,
    performanceRisk: 'none' as RiskLevel,
    compatibilityRisk: 'low' as RiskLevel,
  };
}

describe('recovering a kanby-software-factory run', () => {
  /**
   * The record a process killed during `claim` leaves behind: everything before it
   * completed, `claim` itself is still `running`, and nothing after it exists.
   */
  const crashedAt = (result: Awaited<ReturnType<ReturnType<typeof createKanbyFactory>['run']>>, name: string) => {
    const at = result.steps.findIndex((step) => step.name === name);
    return {
      ...result,
      status: 'running' as const,
      finishedAt: undefined,
      steps: result.steps.slice(0, at + 1).map((step, index) =>
        index === at
          ? { ...step, status: 'running' as const, output: undefined, finishedAt: undefined }
          : step,
      ),
    };
  };

  const sessions = () =>
    fake({
      implement: { summary: 'fixed the formatter' },
      review: review(),
    });

  test('a claim that already landed is adopted rather than claimed again', async () => {
    const first = harness();
    const original = await createKanbyFactory(first.dependencies).run({
      input: input('true'),
      claude: sessions(),
    });
    expect(original.status).toBe('completed');

    const second = harness();
    // The board is the record of what happened: the claim went through before the
    // process died, so it says the task is ours.
    second.task.claimedBy = 'factory-agent';

    const recovered = await createKanbyFactory(second.dependencies).run({
      input: input('true'),
      claude: sessions(),
      resumeFrom: crashedAt(original, 'claim'),
    });

    expect(recovered.status).toBe('completed');
    const claim = recovered.steps.find((step) => step.name === 'claim')!;
    expect(claim.recovered).toBe('reconciled');
    // Asked the board, and did not claim a task it already holds — which `kanby claim`
    // would have refused anyway, failing the recovery for the wrong reason.
    expect(second.effects).toContain('get');
    expect(second.effects).not.toContain('claim');
    expect(second.effects).toContain('release');
  });

  test('a claim that never landed is made', async () => {
    const first = harness();
    const original = await createKanbyFactory(first.dependencies).run({
      input: input('true'),
      claude: sessions(),
    });

    const second = harness();
    second.task.claimedBy = null;

    const recovered = await createKanbyFactory(second.dependencies).run({
      input: input('true'),
      claude: sessions(),
      resumeFrom: crashedAt(original, 'claim'),
    });

    expect(recovered.status).toBe('completed');
    expect(recovered.steps.find((step) => step.name === 'claim')!.recovered).toBe('rerun');
    expect(second.effects).toContain('claim');
  });

  test('a board write interrupted mid-flight is simply repeated', async () => {
    const first = harness();
    const original = await createKanbyFactory(first.dependencies).run({
      input: input('true'),
      claude: sessions(),
    });

    const second = harness();
    second.task.claimedBy = 'factory-agent';
    const recovered = await createKanbyFactory(second.dependencies).run({
      input: input('true'),
      claude: sessions(),
      resumeFrom: crashedAt(original, 'move-in-progress'),
    });

    expect(recovered.status).toBe('completed');
    // A move is a set-operation, so REPEATABLE says do it again rather than stop and ask.
    expect(recovered.steps.find((step) => step.name === 'move-in-progress')!.recovered).toBe('rerun');
    expect(second.effects.filter((effect) => effect === 'move:in_progress')).toHaveLength(1);
  });
});

function harness(taskOverrides: Partial<KanbyTask> = {}) {
  const effects: string[] = [];
  const outputs: { key: string; title: string; body: string }[] = [];
  let updatedContent = '';
  const task: KanbyTask = {
    guid: '019f-task',
    displayNumber: 42,
    title: 'Fix digest dates',
    description: 'Dates render a day early east of UTC.',
    content: '## Specification\n\nAdd timezone-aware digest formatting.',
    status: 'todo',
    blocked: null,
    claimedBy: null,
    updatedMs: 123,
    outputKeys: [
      'kanby-software-factory/classification',
      'kanby-software-factory/analysis',
    ],
    ...taskOverrides,
  };
  const mergeRequest = {
    provider: 'gitlab' as const,
    host: 'https://gitlab.example.internal',
    project: 'group/project',
    iid: 17,
    url: 'https://gitlab.example.internal/group/project/-/merge_requests/17',
    title: '#42 Fix digest dates',
    sourceBranch: 'task/42-digest-dates',
    targetBranch: 'main',
    state: 'opened' as const,
  };

  const kanby = {
    actor: 'factory-agent',
    async get() {
      effects.push('get');
      return structuredClone(task);
    },
    async claim() {
      effects.push('claim');
    },
    async release() {
      effects.push('release');
    },
    async move(_guid: string, status: string) {
      effects.push(`move:${status}`);
    },
    async update(_guid: string, changes: { content: string }) {
      effects.push('update:content');
      updatedContent = changes.content;
    },
    async block(_guid: string, reason: string) {
      effects.push(`block:${reason}`);
    },
    async putOutput(_guid: string, output: { key: string; title: string; body: string }) {
      effects.push(`output:${output.title}`);
      outputs.push(output);
    },
    async linkMergeRequest(_guid: string, linked: { iid: number }) {
      effects.push(`link-mr:${linked.iid}`);
    },
  };

  const repository = {
    async preflight() {
      effects.push('preflight-git');
    },
    async verifyCommit() {
      effects.push('verify-commit');
      return { sha: 'abc123', base: 'base000', commits: 1, diffBytes: 512 };
    },
    async push(_workspace: string, destination: { sourceBranch: string }, sha: string) {
      effects.push(`push:${destination.sourceBranch}:${sha}`);
    },
  };

  const checks = {
    async run(_workspace: string, command: string) {
      effects.push(`checks:${command}`);
      return { stdout: '', stderr: '', exitCode: command === 'false' ? 1 : 0 };
    },
  };

  const mergeRequests = {
    async preflight() {
      effects.push('preflight-gitlab');
    },
    async ensure(request: {
      project: string | number;
      sourceBranch: string;
      targetBranch: string;
    }) {
      effects.push(`ensure-mr:${request.project}:${request.sourceBranch}->${request.targetBranch}`);
      return mergeRequest;
    },
  };

  const dependencies: KanbyFactoryDependencies = {
    kanby,
    repository,
    mergeRequests,
    checks,
  };

  return {
    task,
    effects,
    outputs,
    kanby,
    get updatedContent() {
      return updatedContent;
    },
    dependencies,
  };
}
