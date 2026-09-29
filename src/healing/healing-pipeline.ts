/**
 * HealingPipeline — the brain of the self-healing system.
 *
 * Implements the full decision tree:
 *
 *   Classify failure
 *     ↓
 *   Extract step info  (source line, locator, intent)
 *     ↓
 *   Check healing memory  (instant win for known fixes)
 *     ↓
 *   Deterministic DOM scan  (no LLM, one browser open)
 *     ↓
 *   Confidence gate:  >= AUTO_HEAL → patch immediately
 *                     >= LLM_ASSIST → ask Claude with compact JSON
 *                     < LLM_ASSIST → fallback required
 *     ↓
 *   Patch TypeScript source
 *     ↓
 *   Save to healing memory
 *     ↓
 *   Return result (caller verifies by re-running the test)
 *
 * IMPORTANT: This pipeline handles AUTOMATION failures only.
 * APPLICATION failures (wrong data values, missing features) are
 * detected and returned with fallbackRequired=false so they fail cleanly.
 *
 * If the pipeline cannot heal (complex flow change, unknown failure),
 * it returns fallbackRequired=true so the caller uses the existing
 * repairFlow (full MCP agent loop) as the last resort.
 */
import path from 'path';
import { existsSync } from 'fs';
import { classifyFailure, classifyFailureCategory, cannotHealReason } from './failure-classifier';
import { extractStepInfo, extractBaseUrl, normalizeUrlPath } from './context-extractor';
import { HealingMemory } from './healing-memory';
import { fetchPageElementsWithFallback } from './deterministic-healer';
import { scoreCandidates } from './confidence-scorer';
import { askLLMForDecision } from './llm-decision-layer';
import { patchFile, deleteBackup, restoreBackup, relPath } from './code-patcher';
import type {
  HealingContext,
  HealingResult,
  FailedStepInfo,
  LocatorCandidate,
  HealingConfig,
  StepHealingReport,
} from './types';
import { DEFAULT_HEALING_CONFIG, isLocatorFailure } from './types';

const LIMITS = {
  MAX_HEAL_ATTEMPTS: 3,
  MAX_LLM_CALLS_PER_STEP: 1,
  MAX_CANDIDATES: 5,
} as const;

function log(msg: string, verbose: boolean): void {
  if (verbose) console.log(`  [Heal] ${msg}`);
}

/** Validate that a healed expression matches exactly one visible element on the live page */
async function validateExpression(
  expression: string,
  url: string,
  storageStatePath: string,
): Promise<boolean> {
  // We do a minimal browser open just to check count + visibility
  const { chromium } = await import('playwright');
  const absStorageState = path.isAbsolute(storageStatePath)
    ? storageStatePath
    : path.resolve(process.cwd(), storageStatePath);

  const useStorageState = existsSync(absStorageState);
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  try {
    const context = await browser.newContext(
      useStorageState ? { storageState: absStorageState } : {},
    );
    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForTimeout(500);

    // Build the locator dynamically
    let count = 0;
    let visible = false;
    try {
      // Construct the locator using eval-style approach on the page object
      // We wrap in a try because some expressions may throw on invalid syntax
      const locator = buildLocatorFromExpression(page, expression);
      count = await locator.count();
      visible = count === 1 ? await locator.isVisible() : false;
    } catch {
      return false;
    }

    return count === 1 && visible;
  } catch {
    return false;
  } finally {
    await browser.close().catch(() => null);
  }
}

/** Build a Playwright Locator from an expression string like "getByRole('button', {name:'Login'})" */
function buildLocatorFromExpression(page: import('playwright').Page, expression: string) {
  // Map known expression patterns to Playwright API calls
  const getByRoleMatch = expression.match(/^getByRole\(\s*['"]([^'"]+)['"]\s*,\s*\{[^}]*name\s*:\s*['"]([^'"]+)['"]/);
  if (getByRoleMatch) return page.getByRole(getByRoleMatch[1] as any, { name: getByRoleMatch[2] });

  const getByTestIdMatch = expression.match(/^getByTestId\(\s*['"]([^'"]+)['"]\s*\)/);
  if (getByTestIdMatch) return page.getByTestId(getByTestIdMatch[1]);

  const getByLabelMatch = expression.match(/^getByLabel\(\s*['"]([^'"]+)['"]\s*\)/);
  if (getByLabelMatch) return page.getByLabel(getByLabelMatch[1]);

  const getByTextMatch = expression.match(/^getByText\(\s*['"]([^'"]+)['"]\s*\)/);
  if (getByTextMatch) return page.getByText(getByTextMatch[1]);

  const getByPlaceholderMatch = expression.match(/^getByPlaceholder\(\s*['"]([^'"]+)['"]\s*\)/);
  if (getByPlaceholderMatch) return page.getByPlaceholder(getByPlaceholderMatch[1]);

  // Fall through to locator() for CSS/XPath or any "locator(...)" expression
  const locatorMatch = expression.match(/^locator\(\s*(['"`])(.*?)\1\s*\)/);
  if (locatorMatch) return page.locator(locatorMatch[2]);

  // Last resort: treat the whole expression as a CSS selector
  return page.locator(expression);
}

/**
 * Build URL candidates for the deterministic healer.
 * Tries: extracted URL from spec, BASE_URL env var.
 */
function buildUrlCandidates(context: HealingContext): string[] {
  const urls: string[] = [];

  // Highest priority: currentUrl from the live test run
  if (context.currentUrl) urls.push(context.currentUrl);

  // Second: @pfqa-url tag embedded in the spec by the flow generator
  // — this is the exact URL used during generation, regardless of ENV state
  if (context.specPath) {
    try {
      const { readFileSync } = require('fs') as typeof import('fs');
      const specContent = readFileSync(context.specPath, 'utf-8');
      const pfqaMatch = specContent.match(/\/\/\s*@pfqa-url:\s*(https?:\/\/[^\s\n]+)/);
      if (pfqaMatch) {
        const pfqaUrl = pfqaMatch[1].trim();
        if (!urls.includes(pfqaUrl)) urls.push(pfqaUrl);
      }
    } catch { /* file unreadable — continue */ }
  }

  // Third: ENV variables
  const envBase = process.env.BASE_URL;
  if (envBase && !urls.includes(envBase)) urls.push(envBase);

  return urls.filter(Boolean);
}

export class HealingPipeline {
  private readonly config: HealingConfig;
  private readonly memory: HealingMemory;
  private readonly reports: StepHealingReport[] = [];
  private readonly verbose: boolean;

  constructor(config: Partial<HealingConfig> = {}, verbose = true) {
    this.config = { ...DEFAULT_HEALING_CONFIG, ...config };
    this.memory = new HealingMemory(this.config.memoryPath);
    this.verbose = verbose;
  }

  /** Get all healing reports generated so far */
  getReports(): StepHealingReport[] {
    return [...this.reports];
  }

  /**
   * Attempt to heal a single failing test.
   * Returns a HealingResult describing what happened.
   */
  async heal(context: HealingContext): Promise<HealingResult> {
    const { testTitle, specPath, pomPaths, errorMessage, stackTrace } = context;

    // ── 1. Classify the failure ──────────────────────────────────────────────
    const failureType = classifyFailure(errorMessage, stackTrace);
    const failureCategory = classifyFailureCategory(errorMessage, stackTrace, failureType);

    log(`Failure type: ${failureType} | Category: ${failureCategory}`, this.verbose);

    // Never heal application defects
    const whyNot = cannotHealReason(failureType, failureCategory);
    if (whyNot) {
      log(`Cannot auto-heal: ${whyNot}`, this.verbose);
      const report = this.buildReport(context, failureType, failureCategory, 'NOT_AUTOMATABLE', whyNot);
      this.reports.push(report);
      return {
        success: false,
        failureType,
        failureCategory,
        fallbackRequired: failureCategory === 'AUTOMATION_FAILURE',
        tokensUsed: 0,
        llmUsed: false,
      };
    }

    // Only the fast deterministic path handles locator-type failures.
    // Flow changes, navigation errors, etc. require the full repair agent.
    if (!isLocatorFailure(failureType)) {
      log(`Failure type ${failureType} requires flow-level repair — escalating`, this.verbose);
      const report = this.buildReport(context, failureType, failureCategory, 'SKIPPED', 'Requires flow-level repair');
      this.reports.push(report);
      return {
        success: false,
        failureType,
        failureCategory,
        fallbackRequired: true,
        tokensUsed: 0,
        llmUsed: false,
      };
    }

    // ── 2. Extract failing step info ─────────────────────────────────────────
    const stepInfo = extractStepInfo(errorMessage, stackTrace, pomPaths, specPath);
    if (!stepInfo) {
      log('Could not extract locator from source — escalating', this.verbose);
      return {
        success: false, failureType, failureCategory, fallbackRequired: true, tokensUsed: 0, llmUsed: false,
      };
    }

    log(`Step: ${stepInfo.action} "${stepInfo.intentPhrase}" (${stepInfo.locator}) at ${relPath(stepInfo.filePath)}:${stepInfo.lineNumber}`, this.verbose);

    // ── 3. Check healing memory ──────────────────────────────────────────────
    const pageKey = normalizeUrlPath(context.currentUrl);
    const cached = this.memory.lookup(pageKey, stepInfo.locator);

    if (cached && cached.successCount >= this.config.memoryMinSuccess) {
      log(`Memory hit: "${cached.healedExpression}" (used ${cached.successCount}x)`, this.verbose);
      const patchResult = patchFile(stepInfo, cached.healedExpression);
      if (patchResult.success) {
        log(`Patched from memory: ${patchResult.occurrencesPatched} occurrence(s)`, this.verbose);
        const report = this.buildReport(context, failureType, failureCategory, 'HEALED', undefined, stepInfo, 'MEMORY', cached.healedExpression, cached.confidence, false, 0);
        this.reports.push(report);
        return {
          success: true,
          failureType,
          failureCategory,
          decision: 'HEAL_LOCATOR',
          source: 'MEMORY',
          originalLocator: stepInfo.locator,
          healedExpression: cached.healedExpression,
          confidence: cached.confidence,
          tokensUsed: 0,
          llmUsed: false,
          fallbackRequired: false,
          stepInfo,
        };
      }
      // Memory entry is stale — invalidate and continue
      this.memory.invalidate(pageKey, stepInfo.locator);
      log('Cached healing no longer applies — invalidated', this.verbose);
    }

    // ── 4. Deterministic DOM scan ────────────────────────────────────────────
    log('Running DOM scan...', this.verbose);
    const urlCandidates = buildUrlCandidates(context);
    let candidates: LocatorCandidate[] = [];

    if (urlCandidates.length > 0) {
      try {
        const domResult = await fetchPageElementsWithFallback(
          urlCandidates,
          this.config.storageStatePath,
          30_000,
        );
        if (domResult && domResult.elements.length > 0) {
          candidates = scoreCandidates(
            domResult.elements,
            stepInfo.intentTokens,
            stepInfo.intentPhrase,
            stepInfo.locator,
            this.config.maxCandidates,
          );
          log(`DOM scan: ${domResult.elements.length} elements, ${candidates.length} candidates scored`, this.verbose);
          if (candidates[0]) {
            log(`Best: "${candidates[0].expression}" (confidence ${(candidates[0].confidence * 100).toFixed(0)}%)`, this.verbose);
          }
        }
      } catch (err) {
        log(`DOM scan failed: ${(err as Error).message}`, this.verbose);
      }
    }

    // ── 5. Confidence gate ───────────────────────────────────────────────────
    const best = candidates[0];
    let tokensUsed = 0;
    let llmUsed = false;

    if (best && best.confidence >= this.config.thresholdAutoHeal) {
      // High confidence → patch without asking LLM
      log(`Auto-healing with confidence ${(best.confidence * 100).toFixed(0)}%`, this.verbose);
      const patchResult = patchFile(stepInfo, best.expression);
      if (patchResult.success) {
        this.memory.record(pageKey, stepInfo.locator, best.expression, stepInfo.action, best.confidence);
        const report = this.buildReport(context, failureType, failureCategory, 'HEALED', patchResult.note, stepInfo, 'DETERMINISTIC', best.expression, best.confidence, false, 0);
        this.reports.push(report);
        return {
          success: true,
          failureType,
          failureCategory,
          decision: 'HEAL_LOCATOR',
          source: 'DETERMINISTIC',
          originalLocator: stepInfo.locator,
          healedExpression: best.expression,
          confidence: best.confidence,
          tokensUsed: 0,
          llmUsed: false,
          fallbackRequired: false,
          stepInfo,
        };
      }
    }

    if (best && best.confidence >= this.config.thresholdLlmAssist) {
      // Medium confidence → ask LLM with scored candidates as context
      log(`Asking LLM (best candidate confidence: ${(best.confidence * 100).toFixed(0)}%)`, this.verbose);
      llmUsed = true;

      const decision = await askLLMForDecision(stepInfo, failureType, candidates, undefined, undefined, urlCandidates[0]);
      if (decision) {
        tokensUsed = decision.tokensUsed;
        log(`LLM decision: ${decision.decision} (${(decision.confidence * 100).toFixed(0)}%)${(decision as any).reasoning ? ' — ' + (decision as any).reasoning : ''}`, this.verbose);

        if (decision.decision === 'HEAL_LOCATOR' && decision.expression) {
          const patchResult = patchFile(stepInfo, decision.expression);
          if (patchResult.success) {
            this.memory.record(pageKey, stepInfo.locator, decision.expression, stepInfo.action, decision.confidence);
            const report = this.buildReport(context, failureType, failureCategory, 'HEALED', patchResult.note, stepInfo, 'LLM', decision.expression, decision.confidence, true, tokensUsed);
            this.reports.push(report);
            return {
              success: true,
              failureType,
              failureCategory,
              decision: 'HEAL_LOCATOR',
              source: 'LLM',
              originalLocator: stepInfo.locator,
              healedExpression: decision.expression,
              confidence: decision.confidence,
              tokensUsed,
              llmUsed: true,
              fallbackRequired: false,
              stepInfo,
            };
          }
        }

        if (decision.decision === 'HEAL_FLOW') {
          log('LLM detected flow-level change — escalating to repairFlow', this.verbose);
          const report = this.buildReport(context, failureType, failureCategory, 'SKIPPED', 'Flow-level change detected', stepInfo);
          this.reports.push(report);
          return {
            success: false, failureType, failureCategory, decision: 'HEAL_FLOW',
            fallbackRequired: true, tokensUsed, llmUsed: true,
          };
        }

        if (decision.decision === 'ABORT') {
          log('LLM identified as product defect — not healing', this.verbose);
          const report = this.buildReport(context, failureType, failureCategory, 'NOT_AUTOMATABLE', 'Product defect detected by LLM', stepInfo);
          this.reports.push(report);
          return {
            success: false, failureType, failureCategory, decision: 'ABORT',
            fallbackRequired: false, tokensUsed, llmUsed: true,
          };
        }
      }
    }

    // ── 6. LLM last-ditch attempt — even with zero/weak candidates, ask the LLM
    //    using just the intent + error context. This is especially valuable for
    //    forbidden dynamic IDs (#mantine-*, #ruid-*) where the original locator
    //    is known to be broken by design — the LLM can suggest a correct semantic
    //    locator even without DOM candidates to score against.
    const isForbiddenOriginal = /(?:#mantine-|#ruid-|#react-select-[0-9]|#rc_)[a-z0-9]/.test(stepInfo.locator);
    if (!llmUsed && (isForbiddenOriginal || candidates.length === 0)) {
      log(`Trying LLM with zero/weak candidates (forbidden locator: ${isForbiddenOriginal})`, this.verbose);
      llmUsed = true;
      const fallbackDecision = await askLLMForDecision(
        stepInfo, failureType, candidates, undefined, undefined, urlCandidates[0],
      );
      if (fallbackDecision && fallbackDecision.decision === 'HEAL_LOCATOR' && fallbackDecision.expression) {
        tokensUsed += fallbackDecision.tokensUsed;
        log(`LLM zero-candidate decision: ${fallbackDecision.expression} (${(fallbackDecision.confidence * 100).toFixed(0)}%)`, this.verbose);
        const patchResult = patchFile(stepInfo, fallbackDecision.expression);
        if (patchResult.success) {
          this.memory.record(pageKey, stepInfo.locator, fallbackDecision.expression, stepInfo.action, fallbackDecision.confidence);
          const report = this.buildReport(context, failureType, failureCategory, 'HEALED', patchResult.note, stepInfo, 'LLM', fallbackDecision.expression, fallbackDecision.confidence, true, tokensUsed);
          this.reports.push(report);
          return {
            success: true, failureType, failureCategory, decision: 'HEAL_LOCATOR',
            source: 'LLM', originalLocator: stepInfo.locator,
            healedExpression: fallbackDecision.expression, confidence: fallbackDecision.confidence,
            tokensUsed, llmUsed: true, fallbackRequired: false, stepInfo,
          };
        }
      }
    }

    // ── 7. Fast path exhausted — escalate ────────────────────────────────────
    const reason = candidates.length === 0
      ? 'No DOM candidates found (page may require auth or different URL)'
      : `Best candidate confidence ${best ? (best.confidence * 100).toFixed(0) : 0}% is below threshold`;
    log(`Fast-path healing failed: ${reason}`, this.verbose);

    const report = this.buildReport(context, failureType, failureCategory, 'FAILED', reason, stepInfo, undefined, undefined, undefined, llmUsed, tokensUsed);
    this.reports.push(report);
    return {
      success: false,
      failureType,
      failureCategory,
      fallbackRequired: true,
      tokensUsed,
      llmUsed,
      error: reason,
      stepInfo,
    };
  }

  private buildReport(
    context: HealingContext,
    failureType: import('./types').FailureType,
    failureCategory: import('./types').FailureCategory,
    result: StepHealingReport['result'],
    notes?: string,
    stepInfo?: FailedStepInfo,
    source?: import('./types').HealingSource,
    healedExpression?: string,
    confidence?: number,
    llmUsed = false,
    tokensUsed = 0,
  ): StepHealingReport {
    return {
      testTitle: context.testTitle,
      spec: path.relative(process.cwd(), context.specPath),
      failedStep: stepInfo ? `${stepInfo.action} "${stepInfo.intentPhrase}"` : 'unknown',
      originalLocator: stepInfo?.locator ?? '(unknown)',
      failureType,
      failureCategory,
      healingDecision: healedExpression ? 'HEAL_LOCATOR' : undefined,
      healedExpression,
      confidence,
      healingSource: source,
      validationResult: result === 'HEALED' ? 'PASSED' : undefined,
      llmUsed,
      tokensUsed,
      result,
      notes,
    };
  }
}
