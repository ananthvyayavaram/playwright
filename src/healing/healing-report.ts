/**
 * Generates a human-readable healing report after a heal run.
 *
 * Output goes to:
 *  - Console (formatted table)
 *  - test-results/healing-report.json (structured, for CI/tooling)
 *  - test-results/healing-report.txt (human-readable summary)
 */
import fs from 'fs';
import path from 'path';
import type { StepHealingReport } from './types';

function pad(str: string, len: number): string {
  return str.length >= len ? str.substring(0, len - 1) + '…' : str.padEnd(len);
}

function formatConfidence(c?: number): string {
  return c != null ? `${(c * 100).toFixed(0)}%` : '—';
}

const RESULT_ICONS: Record<StepHealingReport['result'], string> = {
  HEALED:          '✓',
  FAILED:          '✗',
  SKIPPED:         '↷',
  NOT_AUTOMATABLE: '⊘',
};

/**
 * Render a single report block in text form (for console + .txt file)
 */
function renderBlock(r: StepHealingReport): string {
  const lines: string[] = [
    `${'─'.repeat(60)}`,
    `Test:          ${r.testTitle}`,
    `Spec:          ${r.spec}`,
    `Failed step:   ${r.failedStep}`,
    `Original:      ${r.originalLocator}`,
    `Failure type:  ${r.failureType}`,
    `Category:      ${r.failureCategory}`,
  ];
  if (r.healedExpression) {
    lines.push(`Healed to:     page.${r.healedExpression}`);
    lines.push(`Confidence:    ${formatConfidence(r.confidence)}`);
  }
  if (r.healingSource) lines.push(`Source:        ${r.healingSource}`);
  lines.push(`LLM used:      ${r.llmUsed ? `YES (${r.tokensUsed} tokens)` : 'NO (0 tokens)'}`);
  lines.push(`Result:        ${RESULT_ICONS[r.result]} ${r.result}`);
  if (r.notes) lines.push(`Notes:         ${r.notes}`);
  return lines.join('\n');
}

/** Aggregate stats across all reports */
function buildStats(reports: StepHealingReport[]): {
  total: number; healed: number; failed: number; notAutomatable: number;
  totalTokens: number; llmCallCount: number;
} {
  return {
    total:           reports.length,
    healed:          reports.filter(r => r.result === 'HEALED').length,
    failed:          reports.filter(r => r.result === 'FAILED' || r.result === 'SKIPPED').length,
    notAutomatable:  reports.filter(r => r.result === 'NOT_AUTOMATABLE').length,
    totalTokens:     reports.reduce((s, r) => s + r.tokensUsed, 0),
    llmCallCount:    reports.filter(r => r.llmUsed).length,
  };
}

function buildSummaryBlock(stats: ReturnType<typeof buildStats>): string {
  return [
    '',
    '═══ SELF-HEALING SUMMARY ════════════════════════════════',
    `Total steps healed:       ${stats.healed} / ${stats.total}`,
    `Failed (needs repairFlow): ${stats.failed}`,
    `Product defects detected:  ${stats.notAutomatable}`,
    `LLM calls made:            ${stats.llmCallCount}`,
    `Total LLM tokens used:     ${stats.totalTokens}`,
    '═════════════════════════════════════════════════════════',
    '',
  ].join('\n');
}

/**
 * Print the healing report to the console and write files.
 *
 * @param reports   All StepHealingReport entries from this run
 * @param outputDir Directory for report files (default: test-results/)
 */
export function writeHealingReport(
  reports: StepHealingReport[],
  outputDir = path.resolve(process.cwd(), 'test-results'),
): void {
  if (reports.length === 0) return;

  const stats = buildStats(reports);

  // Console output
  console.log('\n[HealReporter] SELF-HEALING REPORT');
  for (const r of reports) {
    console.log(renderBlock(r));
  }
  console.log(buildSummaryBlock(stats));

  // Ensure output directory exists
  try { fs.mkdirSync(outputDir, { recursive: true }); } catch { /* ignore */ }

  // JSON report
  try {
    const jsonPath = path.join(outputDir, 'healing-report.json');
    fs.writeFileSync(
      jsonPath,
      JSON.stringify({ timestamp: new Date().toISOString(), stats, reports }, null, 2),
      'utf-8',
    );
  } catch { /* non-fatal */ }

  // Text summary
  try {
    const txtPath = path.join(outputDir, 'healing-report.txt');
    const lines: string[] = [
      `SELF-HEALING REPORT  ${new Date().toISOString()}`,
      ...reports.map(r => renderBlock(r)),
      buildSummaryBlock(stats),
    ];
    fs.writeFileSync(txtPath, lines.join('\n'), 'utf-8');
  } catch { /* non-fatal */ }
}

/**
 * Quick one-line summary per healed spec, compatible with the existing
 * HealReporter console output style.
 */
export function formatHealLine(r: StepHealingReport): string {
  const icon = RESULT_ICONS[r.result];
  const src = r.healingSource ? `[${r.healingSource}]` : '';
  const tokens = r.tokensUsed > 0 ? ` ${r.tokensUsed}t` : '';
  return `${icon} ${path.basename(r.spec)} — ${r.failedStep} ${src}${tokens}`;
}
