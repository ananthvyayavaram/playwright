// Lightweight perf tracker for token usage across pipeline stages.
// Records per-stage call counts, token totals, and wall-clock durations.
// Prints a summary on process exit (set SUPPRESS_METRICS=1 to skip).
import process from 'process';

interface StageMetric {
  calls:        number;
  inputTokens:  number;
  outputTokens: number;
  durationMs:   number;
}

const metrics    = new Map<string, StageMetric>();
const sessionStart = Date.now();

export function trackTokens(stage: string, input: number, output: number, durationMs = 0): void {
  const prev = metrics.get(stage) ?? { calls: 0, inputTokens: 0, outputTokens: 0, durationMs: 0 };
  metrics.set(stage, {
    calls:        prev.calls + 1,
    inputTokens:  prev.inputTokens + input,
    outputTokens: prev.outputTokens + output,
    durationMs:   prev.durationMs + durationMs,
  });
}

export function printMetricsSummary(): void {
  if (metrics.size === 0) return;

  const elapsed = ((Date.now() - sessionStart) / 1000).toFixed(1);
  console.log('\n╔═══ Token Usage Summary ════════════════════════════════╗');
  console.log(`║  Session time: ${elapsed}s`);
  console.log('║');

  let totalIn = 0, totalOut = 0, totalCalls = 0;
  for (const [stage, m] of metrics) {
    totalIn    += m.inputTokens;
    totalOut   += m.outputTokens;
    totalCalls += m.calls;
    const total  = m.inputTokens + m.outputTokens;
    const avgDur = m.calls > 0 ? (m.durationMs / m.calls / 1000).toFixed(1) : '—';
    console.log(
      `║  ${stage.padEnd(22)} calls=${String(m.calls).padStart(3)}  ` +
      `in=${String(m.inputTokens).padStart(7)}  out=${String(m.outputTokens).padStart(6)}  ` +
      `total=${String(total).padStart(7)}  avg=${avgDur}s`,
    );
  }

  console.log('║');
  console.log(
    `║  ${'TOTAL'.padEnd(22)} calls=${String(totalCalls).padStart(3)}  ` +
    `in=${String(totalIn).padStart(7)}  out=${String(totalOut).padStart(6)}  ` +
    `total=${String(totalIn + totalOut).padStart(7)}`,
  );
  console.log('╚═════════════════════════════════════════════════════════╝\n');
}

process.on('exit', () => {
  if (metrics.size > 0 && process.env.SUPPRESS_METRICS !== '1') {
    printMetricsSummary();
  }
});
