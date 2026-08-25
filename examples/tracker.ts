/**
 * A stand-in for whatever system of record you actually use — an issue tracker, a
 * git host, a status page. Every one of these is an External effect: pipeline code
 * calls it from a step's Output, and Claude never touches it.
 */
export interface Issue {
  id: number;
  title: string;
  body: string;
  labels: string[];
  blocked?: string;
  comments: string[];
}

const issues = new Map<number, Issue>([
  [
    42,
    {
      id: 42,
      title: 'Dates render a day early in the digest email',
      body: 'The weekly digest shows 2026-08-24 for events on 2026-08-25 for users east of UTC.',
      labels: [],
      comments: [],
    },
  ],
]);

export const tracker = {
  async get(id: number): Promise<Issue> {
    const issue = issues.get(id);
    if (!issue) throw new Error(`No such issue: ${id}`);
    return structuredClone(issue);
  },
  async addLabels(id: number, labels: string[]): Promise<void> {
    const issue = issues.get(id)!;
    issue.labels = [...new Set([...issue.labels, ...labels])];
    console.log(`  → labelled #${id}: ${issue.labels.join(', ')}`);
  },
  async block(id: number, reason: string): Promise<void> {
    issues.get(id)!.blocked = reason;
    console.log(`  → blocked #${id}: ${reason}`);
  },
  async comment(id: number, body: string): Promise<void> {
    issues.get(id)!.comments.push(body);
    console.log(`  → commented on #${id}: ${body}`);
  },
};
