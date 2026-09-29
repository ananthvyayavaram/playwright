// AI failure analysis: reads Allure results or a Playwright JSON report,
// classifies each failure, and suggests fixes.

import { createAnthropicClient, resolveModel } from './anthropic-client';
import { readdirSync, readFileSync, existsSync } from 'fs';
import path from 'path';

export interface FailureInput {
  testTitle:   string;
  errorMessage: string;
  stackTrace?:  string;
  specFile?:    string;
  duration?:    number;
}

export interface FailureReport {
  rootCause:        string;
  category:         'locator' | 'timeout' | 'assertion' | 'network' | 'auth' | 'data' | 'environment' | 'unknown';
  severity:         'critical' | 'high' | 'medium' | 'low';
  likelyFlaky:      boolean;
  suggestedFix:     string;
  locatorToUpdate?: string;
  affectedFile?:    string;
}

export interface BatchResult {
  analyzed: number;
  reports:  Array<{ input: FailureInput; report: FailureReport | null }>;
}

const SYSTEM_PROMPT = `You are a senior QA engineer analyzing Playwright test failures.
For each failure provided, return a JSON array where each element has:
{
  "rootCause":        "one sentence",
  "category":         "locator|timeout|assertion|network|auth|data|environment|unknown",
  "severity":         "critical|high|medium|low",
  "likelyFlaky":      true/false,
  "suggestedFix":     "actionable one-sentence suggestion",
  "locatorToUpdate":  "optional: the exact selector that likely needs updating",
  "affectedFile":     "optional: relative file path"
}
Return ONLY a valid JSON array, no markdown, no explanation outside JSON.`;

function buildBatchPrompt(failures: FailureInput[]): string {
  return failures.map((f, i) =>
    `### Test ${i + 1}: ${f.testTitle}\n` +
    (f.specFile ? `File: ${f.specFile}\n` : '') +
    `Error: ${f.errorMessage}\n` +
    (f.stackTrace ? `Stack:\n${f.stackTrace.slice(0, 1200)}\n` : '')
  ).join('\n---\n');
}

export async function analyzeFailures(failures: FailureInput[], model?: string): Promise<BatchResult> {
  if (!failures.length) return { analyzed: 0, reports: [] };

  const client    = createAnthropicClient();
  const modelId   = resolveModel(model ?? 'claude-haiku-4-5-20251001'); // Fast model for batch analysis
  const userText  = buildBatchPrompt(failures);

  let rawText = '';
  try {
    const response = await client.messages.create({
      model:      modelId,
      max_tokens: 4096,
      system:     SYSTEM_PROMPT,
      messages:   [{ role: 'user', content: userText }],
    });
    rawText = response.content.find(b => b.type === 'text')?.text ?? '';
  } catch (err) {
    console.error('[failure-analyzer] API error:', err instanceof Error ? err.message : err);
    return { analyzed: failures.length, reports: failures.map(input => ({ input, report: null })) };
  }

  let parsed: FailureReport[] = [];
  try {
    const start = rawText.indexOf('[');
    const end   = rawText.lastIndexOf(']');
    parsed = JSON.parse(rawText.slice(start, end + 1)) as FailureReport[];
  } catch {
    return { analyzed: failures.length, reports: failures.map(input => ({ input, report: null })) };
  }

  return {
    analyzed: failures.length,
    reports:  failures.map((input, i) => ({ input, report: parsed[i] ?? null })),
  };
}

// ─── Allure Results Reader ─────────────────────────────────────────────────

interface AllureResult {
  name?:      string;
  status?:    string;
  statusDetails?: { message?: string; trace?: string };
  labels?:    Array<{ name: string; value: string }>;
  testCaseId?: string;
}

export async function analyzeAllureResults(allureDir: string, model?: string): Promise<BatchResult> {
  if (!existsSync(allureDir)) return { analyzed: 0, reports: [] };

  const failures: FailureInput[] = [];
  const resultFiles = readdirSync(allureDir).filter(f => f.endsWith('-result.json'));

  for (const file of resultFiles) {
    try {
      const data = JSON.parse(readFileSync(path.join(allureDir, file), 'utf-8')) as AllureResult;
      if (!data.status || data.status === 'passed' || data.status === 'skipped') continue;
      failures.push({
        testTitle:    data.name ?? file,
        errorMessage: data.statusDetails?.message ?? '',
        stackTrace:   data.statusDetails?.trace   ?? '',
      });
    } catch { /* skip unreadable files */ }
  }

  return analyzeFailures(failures, model);
}

// ─── Playwright JSON Report Reader ────────────────────────────────────────

interface PwSuite  { title: string; specs?: PwSpec[]; suites?: PwSuite[] }
interface PwSpec   { title: string; file?: string; tests?: PwTest[] }
interface PwTest   { status?: string; results?: Array<{ error?: { message?: string; stack?: string }; duration?: number }> }
interface PwReport { suites?: PwSuite[] }

function flattenPwSuites(suites: PwSuite[], acc: FailureInput[] = []): FailureInput[] {
  for (const suite of suites) {
    if (suite.suites) flattenPwSuites(suite.suites, acc);
    for (const spec of (suite.specs ?? [])) {
      for (const test of (spec.tests ?? [])) {
        if (test.status === 'passed' || test.status === 'skipped') continue;
        const result = test.results?.[0];
        acc.push({
          testTitle:    `${suite.title} > ${spec.title}`.trim(),
          errorMessage: result?.error?.message ?? '',
          stackTrace:   result?.error?.stack   ?? '',
          specFile:     spec.file,
          duration:     result?.duration,
        });
      }
    }
  }
  return acc;
}

export async function analyzePlaywrightReport(reportPath: string, model?: string): Promise<BatchResult> {
  if (!existsSync(reportPath)) return { analyzed: 0, reports: [] };
  let report: PwReport;
  try { report = JSON.parse(readFileSync(reportPath, 'utf-8')) as PwReport; } catch { return { analyzed: 0, reports: [] }; }
  const failures = flattenPwSuites(report.suites ?? []);
  return analyzeFailures(failures, model);
}
