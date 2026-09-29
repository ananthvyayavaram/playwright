/**
 * Scores locator candidates against the original intent.
 *
 * Scoring is purely deterministic — no LLM involved.
 * Each factor is weighted and clamped to [0, 1].
 *
 * Total score >= 0.90 → auto-heal without LLM
 * Total score 0.50-0.89 → send to LLM with candidates as context
 * Total score < 0.50 → fall back to repairFlow (full agent loop)
 */
import type { LocatorCandidate, PageElement } from './types';

/** Weight table — must sum to 1.0 */
const WEIGHTS = {
  roleTagMatch:      0.18,
  textExact:         0.28,
  textPartial:       0.14,
  testIdMatch:       0.18,
  ariaLabelMatch:    0.12,
  idMatch:           0.06,
  historicalSuccess: 0.04,
};

/** Common role aliases */
const ROLE_SYNONYMS: Record<string, string[]> = {
  button:   ['button', 'btn', 'submit', 'reset'],
  link:     ['link', 'a', 'anchor', 'href', 'lnk'],
  input:    ['input', 'textbox', 'text', 'field', 'inp'],
  select:   ['select', 'combobox', 'dropdown', 'drp'],
  checkbox: ['checkbox', 'check', 'toggle', 'chk'],
  option:   ['option', 'item', 'menuitem'],
};

function getRoleGroup(value: string): string {
  const v = value.toLowerCase();
  for (const [group, aliases] of Object.entries(ROLE_SYNONYMS)) {
    if (aliases.some(a => v === a || v.includes(a))) return group;
  }
  return v;
}

/** Returns 0–1 representing how many of the intentTokens appear in the target string */
function tokenOverlap(intentTokens: string[], target: string): number {
  if (!target || intentTokens.length === 0) return 0;
  const lower = target.toLowerCase();
  const matched = intentTokens.filter(t => lower.includes(t)).length;
  return matched / intentTokens.length;
}

function scoreElement(
  el: PageElement,
  intentTokens: string[],
  intentPhrase: string,
  originalLocator: string,
): { score: number; reasons: string[] } {
  let score = 0;
  const reasons: string[] = [];

  // 1. Role / tag match
  const elRole = (el.role ?? el.tag ?? '').toLowerCase();
  const intentGroup = getRoleGroup(intentPhrase);
  const elGroup = getRoleGroup(elRole);
  if (intentGroup && elGroup && intentGroup === elGroup) {
    score += WEIGHTS.roleTagMatch;
    reasons.push(`role match (${elGroup})`);
  } else if (elRole === intentGroup) {
    score += WEIGHTS.roleTagMatch * 0.5;
    reasons.push(`partial role match`);
  }

  // 2. Exact text match
  const elText = (el.text ?? '').trim().toLowerCase();
  const intentLower = intentPhrase.toLowerCase();
  if (elText && elText === intentLower) {
    score += WEIGHTS.textExact;
    reasons.push(`exact text match ("${el.text}")`);
  } else if (elText && intentLower && elText.includes(intentLower)) {
    score += WEIGHTS.textExact * 0.7;
    reasons.push(`text contains intent`);
  } else {
    const overlap = tokenOverlap(intentTokens, el.text ?? '');
    if (overlap > 0) {
      score += WEIGHTS.textPartial * overlap;
      reasons.push(`text token overlap (${(overlap * 100).toFixed(0)}%)`);
    }
  }

  // 3. data-testid contains intent tokens
  if (el.testId) {
    const overlap = tokenOverlap(intentTokens, el.testId);
    if (overlap > 0) {
      score += WEIGHTS.testIdMatch * overlap;
      reasons.push(`testId overlap (${el.testId})`);
    }
  }

  // 4. aria-label match
  if (el.ariaLabel) {
    const overlap = tokenOverlap(intentTokens, el.ariaLabel);
    if (overlap > 0) {
      score += WEIGHTS.ariaLabelMatch * overlap;
      reasons.push(`aria-label overlap (${el.ariaLabel})`);
    }
  }

  // 5. id match with original locator tokens
  if (el.id) {
    const origTokens = originalLocator.toLowerCase().replace(/[#.\[\]'"={}()]/g, ' ').split(/\s+/).filter(Boolean);
    const overlap = tokenOverlap(origTokens, el.id);
    if (overlap > 0) {
      score += WEIGHTS.idMatch * overlap;
      reasons.push(`id overlap (${el.id})`);
    }
  }

  return { score: Math.min(score, 1.0), reasons };
}

/** Convert a PageElement to the best Playwright locator expression */
function buildExpression(el: PageElement): string {
  // Priority: testId > aria-label > role+text > visible text > id > name > css
  if (el.testId) return `getByTestId('${el.testId}')`;
  if (el.ariaLabel) return `getByRole('${el.role ?? el.tag}', { name: '${el.ariaLabel}' })`;
  if (el.text && el.role && ['button', 'link', 'combobox', 'checkbox'].includes(el.role)) {
    const cleanText = el.text.replace(/'/g, "\\'").substring(0, 50);
    return `getByRole('${el.role}', { name: '${cleanText}' })`;
  }
  if (el.text && el.tag === 'button') {
    const cleanText = el.text.replace(/'/g, "\\'").substring(0, 50);
    return `getByRole('button', { name: '${cleanText}' })`;
  }
  if (el.text && el.tag === 'a') {
    const cleanText = el.text.replace(/'/g, "\\'").substring(0, 50);
    return `getByRole('link', { name: '${cleanText}' })`;
  }
  if (el.text) {
    const cleanText = el.text.replace(/'/g, "\\'").substring(0, 50);
    return `getByText('${cleanText}')`;
  }
  if (el.id) return `locator('#${el.id}')`;
  if (el.name) return `locator('[name="${el.name}"]')`;
  return `locator('${el.tag}')`;
}

/** Build a CSS selector that can be stored as a string in POM properties */
function buildCssSelector(el: PageElement): string {
  if (el.testId) return `[data-testid="${el.testId}"]`;
  if (el.id) return `#${el.id}`;
  if (el.ariaLabel) return `[aria-label="${el.ariaLabel}"]`;
  if (el.name) return `[name="${el.name}"]`;
  return el.tag;
}

/**
 * Score all page elements and return the top-N candidates ranked by confidence.
 */
export function scoreCandidates(
  elements: PageElement[],
  intentTokens: string[],
  intentPhrase: string,
  originalLocator: string,
  maxCandidates = 5,
): LocatorCandidate[] {
  const scored: LocatorCandidate[] = [];

  for (const el of elements) {
    if (!el.visible) continue; // Invisible elements are unlikely candidates

    const { score, reasons } = scoreElement(el, intentTokens, intentPhrase, originalLocator);
    if (score < 0.15) continue; // Too low to be useful

    scored.push({
      expression: buildExpression(el),
      selector: buildCssSelector(el),
      strategy: 'dom_scan',
      confidence: score,
      reason: reasons.join(', '),
      element: el,
    });
  }

  // Sort descending, return top N
  return scored.sort((a, b) => b.confidence - a.confidence).slice(0, maxCandidates);
}

/**
 * Build candidates from a healed locator returned by LLM/memory (no element needed).
 * Used when we trust the expression but haven't scored it against DOM.
 */
export function buildCandidateFromExpression(
  expression: string,
  confidence: number,
  strategy: string,
  reason: string,
): LocatorCandidate {
  return {
    expression,
    selector: expression,
    strategy,
    confidence,
    reason,
  };
}
