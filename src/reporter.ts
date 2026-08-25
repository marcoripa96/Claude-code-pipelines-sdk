import type { EventListener, NodeInfo, RunSummary } from './types.ts';

const useColor = process.env.NO_COLOR === undefined && process.env.TERM !== 'dumb';
const c = (code: number) => (text: string) => (useColor ? `\x1b[${code}m${text}\x1b[0m` : text);
const dim = c(2);
const bold = c(1);
const red = c(31);
const green = c(32);
const yellow = c(33);
const blue = c(34);
const magenta = c(35);

const KIND_COLOR = { exec: blue, claude: magenta, step: yellow } as const;

/**
 * Human-readable progress on stderr: one line when a node starts, one when it
 * ends, and a summary at the end. Output goes to stderr so a pipeline can still
 * pipe real data out on stdout.
 */
export function consoleReporter(options: { verbose?: boolean } = {}): EventListener {
  const verbose = options.verbose ?? process.env.PIPELINE_VERBOSE === '1';

  return (event) => {
    switch (event.type) {
      case 'run:start':
        write(`\n${bold(`▶ ${event.pipeline}`)} ${dim(event.runId)}\n`);
        break;
      case 'node:start':
        write(`${dim('  ┌ ')}${label(event.node)}\n`);
        break;
      case 'node:log':
        if (verbose) write(`${dim('  │ ')}${dim(truncate(event.message, 160))}\n`);
        break;
      case 'node:tool':
        if (verbose) write(`${dim('  │ ')}${dim(`⚙ ${event.tool}`)}\n`);
        break;
      case 'node:retry':
        write(`${yellow('  ↻ ')}${label(event.node)} ${dim(`attempt ${event.attempt} failed: ${truncate(event.error, 100)}`)}\n`);
        break;
      case 'node:end': {
        const { node } = event;
        const mark =
          node.status === 'failed'
            ? red('✗')
            : node.status === 'cached'
              ? green('◆')
              : node.status === 'replayed'
                ? green('⤿')
                : green('✓');
        const note = node.status === 'cached' ? dim(' cached') : node.status === 'replayed' ? dim(' replayed') : '';
        write(`${dim('  └')}${mark} ${label(node)}${note} ${dim(formatMs(node.durationMs))}\n`);
        if (node.status === 'failed' && node.error) write(`    ${red(truncate(node.error, 400))}\n`);
        break;
      }
      case 'log':
        write(`${dim('  • ')}${event.message}\n`);
        break;
      case 'run:end':
        write(summarize(event.summary));
        break;
    }
  };
}

function summarize(summary: RunSummary): string {
  const counts = { success: 0, cached: 0, replayed: 0, failed: 0 };
  for (const node of summary.nodes) counts[node.status] += 1;
  const parts = [
    `${counts.success} ran`,
    counts.cached ? `${counts.cached} cached` : '',
    counts.replayed ? `${counts.replayed} replayed` : '',
    counts.failed ? red(`${counts.failed} failed`) : '',
    summary.costUsd > 0 ? `$${summary.costUsd.toFixed(4)}` : '',
  ].filter(Boolean);
  const head = summary.ok ? green('■ done') : red('■ failed');
  return `${head} ${dim(`${parts.join(' · ')} · ${formatMs(summary.durationMs)}`)}\n\n`;
}

function label(node: NodeInfo): string {
  return `${KIND_COLOR[node.kind](node.kind)} ${bold(node.name)}`;
}

function formatMs(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function truncate(text: string, max: number): string {
  const single = text.replace(/\s+/g, ' ').trim();
  return single.length <= max ? single : `${single.slice(0, max - 1)}…`;
}

function write(text: string): void {
  process.stderr.write(text);
}
