/**
 * How the factory renders itself as text: the markdown it publishes to the board, the
 * merge request description, and the risk scale those two read from.
 *
 * Pure functions of their arguments. Nothing here knows about the SDK, the board or a
 * run, which is what keeps the driver readable and these assertable on their own.
 */
import { RISK_LEVELS, type KanbyTask, type RiskLevel } from './contracts.ts';

/** Where a level sits on the scale `RISK_LEVELS` declares. */
export function rank(level: RiskLevel): number {
  return RISK_LEVELS.indexOf(level);
}

/** The dimension a human should look at first, and how hard. */
export function peakRisk(output: {
  sideEffectRisk: RiskLevel;
  performanceRisk: RiskLevel;
  compatibilityRisk: RiskLevel;
}): { dimension: string; level: RiskLevel } {
  const dimensions = [
    { dimension: 'Side-effect', level: output.sideEffectRisk },
    { dimension: 'Performance', level: output.performanceRisk },
    { dimension: 'Compatibility', level: output.compatibilityRisk },
  ];
  return dimensions.reduce((peak, next) => (rank(next.level) > rank(peak.level) ? next : peak));
}

/** What the peak risk asks of the human who opens the merge request. */
export function reviewDepth(level: RiskLevel): string {
  if (level === 'high') return 'deep review';
  if (level === 'medium') return 'focused review';
  return 'quick verification';
}

export function label(task: KanbyTask): string {
  return task.displayNumber === null ? task.guid : `#${task.displayNumber}`;
}

export function withRound(round: number, body: string): string {
  return round === 1 ? body : `**Revision round ${round}**\n\n${body}`;
}

export function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function mergeRequestDescription(
  task: KanbyTask,
  output: {
    summary: string;
    sideEffectRisk: RiskLevel;
    performanceRisk: RiskLevel;
    compatibilityRisk: RiskLevel;
  },
  type: string | undefined,
): string {
  const peak = peakRisk(output);
  return [
    output.summary,
    '',
    `**Suggested review depth:** ${reviewDepth(peak.level)} — ` +
    `${peak.dimension.toLowerCase()} risk is ${peak.level}.`,
    '',
    type ? `Kanby task: ${task.guid} (${type})` : `Kanby task: ${task.guid}`,
  ].join('\n');
}

export function formatClassification(output: {
  type: string;
  confidence: number;
  rationale: string;
  requiresHumanTriage: boolean;
}): string {
  return [
    `**Type:** ${output.type}`,
    `**Confidence:** ${Math.round(output.confidence * 100)}%`,
    `**Human triage:** ${output.requiresHumanTriage ? 'required' : 'not required'}`,
    '',
    output.rationale,
  ].join('\n');
}

export function formatAnalysis(
  output: {
    ready: boolean;
    reason: string;
    evidence: string[];
    specification: string;
    plan: string[];
    compatibility: string;
    risk: string;
    requiredChecks: string[];
  },
  type: string,
): string {
  return [
    `**Task type:** ${type}`,
    '',
    output.reason,
    '',
    '## Evidence',
    '',
    ...output.evidence.map((item) => `- ${item}`),
    '',
    '## Specification',
    '',
    output.specification,
    '',
    '## Implementation plan',
    '',
    ...output.plan.map((item) => `- ${item}`),
    '',
    '## Compatibility and risk',
    '',
    `**Compatibility:** ${output.compatibility}`,
    `**Risk:** ${output.risk}`,
    '',
    '## Required checks',
    '',
    ...output.requiredChecks.map((item) => `- ${item}`),
  ].join('\n');
}

export function formatCommandOutput(command: string, exitCode: number, stdout: string, stderr: string): string {
  const transcript = truncate([stdout.trimEnd(), stderr.trimEnd()].filter(Boolean).join('\n'), 20_000);
  return [
    '## Command',
    '',
    indent(command),
    '',
    `Exit code: \`${exitCode}\``,
    '',
    '## Output',
    '',
    indent(transcript || '(no output)'),
  ].join('\n');
}

export function formatReview(output: {
  summary: string;
  completeness: string;
  concerns: string[];
  sideEffectRisk: RiskLevel;
  performanceRisk: RiskLevel;
  compatibilityRisk: RiskLevel;
}): string {
  const concerns = output.concerns.length > 0
    ? ['## Concerns', '', ...output.concerns.map((concern) => `- ${concern}`), '']
    : [];
  return [
    output.summary,
    '',
    `**Completeness:** ${output.completeness}`,
    `**Side-effect risk:** ${output.sideEffectRisk}`,
    `**Performance risk:** ${output.performanceRisk}`,
    `**Compatibility risk:** ${output.compatibilityRisk}`,
    `**Suggested review depth:** ${reviewDepth(peakRisk(output).level)}`,
    '',
    ...concerns,
  ].join('\n').trimEnd();
}

function indent(value: string): string {
  return value.split('\n').map((line) => `    ${line}`).join('\n');
}

function truncate(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}\n\n[output truncated at ${limit} characters]`;
}
