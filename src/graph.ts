import type { RunGraph } from './types.ts';

/**
 * Render the graph a run actually executed as Mermaid.
 *
 * The graph is a record, not a plan: it is derived from which node results were
 * chained into which, so it reflects the run that happened.
 */
export function toMermaid(graph: RunGraph, options: { direction?: 'TD' | 'LR' } = {}): string {
  const lines = [`graph ${options.direction ?? 'TD'}`];
  const id = (name: string) => `n${Buffer.from(name).toString('hex')}`;

  for (const node of graph.nodes) {
    const suffix =
      node.status === 'cached' ? ' (cached)' : node.status === 'replayed' ? ' (replayed)' : node.status === 'failed' ? ' (failed)' : '';
    lines.push(`  ${id(node.name)}["${node.kind}: ${node.name}${suffix}"]`);
  }
  for (const edge of graph.edges) lines.push(`  ${id(edge.from)} --> ${id(edge.to)}`);

  const failed = graph.nodes.filter((n) => n.status === 'failed');
  if (failed.length > 0) {
    lines.push('  classDef failed stroke:#e5484d,stroke-width:2px;');
    lines.push(`  class ${failed.map((n) => id(n.name)).join(',')} failed;`);
  }
  return lines.join('\n');
}

/** Compact one-line-per-node text rendering, useful in logs and CI output. */
export function toText(graph: RunGraph): string {
  return graph.nodes
    .map((node) => {
      const deps = node.parents.length > 0 ? ` <- ${node.parents.join(', ')}` : '';
      return `${node.status.padEnd(8)} ${node.kind.padEnd(6)} ${node.name}${deps} (${node.durationMs}ms)`;
    })
    .join('\n');
}
