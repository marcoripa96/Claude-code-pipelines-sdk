import { describe, expect, test } from 'bun:test';
import { fake } from '@marcoripa96/claude-code-pipelines-sdk';
import { implementIssue } from '../examples/implement-issue.ts';

/**
 * The example is imported by package name, so it breaks loudly when the API changes,
 * and its branches are asserted against fixture Outputs with no session opened.
 */
describe('the implement-issue example', () => {
  test('implements, tests and reports when the analysis says it is viable', async () => {
    const result = await implementIssue.run({
      input: { issueId: 42, testCommand: 'true' },
      claude: fake({
        classify: { type: 'bug', labels: ['bug'] },
        analyze: { viable: true, reason: 'local fix', plan: 'format in the user timezone' },
        implement: { summary: 'fixed the formatter', filesChanged: ['src/digest/format.ts'] },
        review: { approved: true, concerns: [] },
      }),
    });

    expect(result.status).toBe('completed');
    expect(result.output).toMatchObject({ approved: true, summary: 'fixed the formatter' });
    expect(result.steps.find((s) => s.name === 'block')?.status).toBeUndefined();
  });

  test('blocks and halts when the analysis says it is not viable', async () => {
    const claude = fake({
      classify: { type: 'feature', labels: ['feature'] },
      analyze: { viable: false, reason: 'the requirement is contradictory', plan: '' },
    });

    const result = await implementIssue.run({ input: { issueId: 42, testCommand: 'true' }, claude });

    expect(result.status).toBe('halted');
    expect(result.haltReason).toBe('not viable');
    expect(result.steps.find((s) => s.name === 'block')?.status).toBe('completed');
    for (const name of ['implement', 'test', 'review', 'report']) {
      expect(result.steps.find((s) => s.name === name)?.status).toBe('skipped');
    }
    expect(claude.calls.map((c) => c.stepName)).toEqual(['classify', 'analyze']);
  });

  test('reports the concerns when the review does not approve', async () => {
    const result = await implementIssue.run({
      input: { issueId: 42, testCommand: 'true' },
      claude: fake({
        classify: { type: 'bug', labels: ['bug'] },
        analyze: { viable: true, reason: 'local fix', plan: 'format in the user timezone' },
        implement: { summary: 'fixed the formatter', filesChanged: [] },
        review: { approved: false, concerns: ['no test covers the DST boundary'] },
      }),
    });

    expect(result.status).toBe('completed');
    expect(result.output).toMatchObject({ approved: false });
  });
});
