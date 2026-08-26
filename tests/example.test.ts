import { describe, expect, test } from 'bun:test';
import { fake } from '@marcoripa96/claude-code-pipelines-sdk';
import {
  createKanbyFactory,
  type KanbyTask,
  type KanbyFactoryDependencies,
  type RiskLevel,
} from '../examples/kanby-software-factory/pipeline.ts';

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
      'checks:true',
      'output:Checks',
      'stage-change:100000',
      'output:Review',
      'commit',
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
      'checks:true',
      'output:Checks',
      'stage-change:100000',
      'output:Review',
      'commit',
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
    expect(fixture.effects).not.toContain('commit');
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
      'checks:true',
      'output:Checks',
      'stage-change:100000',
      'output:Review',
      'output:Implementation',
      'checks:true',
      'output:Checks',
      'stage-change:100000',
      'output:Review',
      'commit',
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
    expect(fixture.effects).not.toContain('commit');
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
    expect(fixture.effects).not.toContain('commit');
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
      'check-2',
      'publish-checks-2',
      'stage-change-2',
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
    expect(fixture.effects).not.toContain('commit');
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
    expect(fixture.effects).toContain('commit');
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
  overrides: { maxUnattendedRisk?: 'none' | 'low' | 'medium' | 'high' } = {},
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
    async stage(_workspace: string, _branch: string, maxDiffBytes: number) {
      effects.push(`stage-change:${maxDiffBytes}`);
      return { truncated: false };
    },
    async commit() {
      effects.push('commit');
      return { sha: 'abc123' };
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
