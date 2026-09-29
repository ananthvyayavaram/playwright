/**
 * Compact LLM integration for the healing pipeline.
 *
 * Sends a minimal structured JSON payload to Claude and receives a single
 * structured JSON decision. No agent loop. No browser tools.
 * One API call per failing step.
 *
 * Token budget: ~600 input + ~200 output = ~800 tokens per call
 */
import { createAnthropicClient, resolveModel } from '../ai/anthropic-client';
import type { FailedStepInfo, LocatorCandidate, HealingDecision } from './types';

const SYSTEM_PROMPT = `You are a WORLD-CLASS QA AUTOMATION ENGINEER and Playwright healing specialist.
You have 10+ years of experience with enterprise web applications and you deeply understand:
- How UI component libraries (Mantine, Material-UI, Ant Design, React Select) generate dynamic IDs
- How SPAs change DOM structure across deployments
- What makes locators brittle vs resilient
- How to think from the BUSINESS PERSPECTIVE: what is this test trying to verify?

A Playwright locator is failing. Your job is to pick the BEST fix from the candidates provided,
or to escalate when a locator fix alone cannot solve the problem.

═══════════════════════════════════════════════════════════
DECISION TYPES (return exactly one):
═══════════════════════════════════════════════════════════
- HEAL_LOCATOR : a candidate expression will fix the broken locator
- HEAL_WAIT    : the element IS there but timing/loading is the issue (no locator change needed)
- HEAL_FRAME   : the element is inside an iframe (no locator change needed)
- HEAL_POPUP   : a modal/overlay is blocking the element before it can be reached
- HEAL_FLOW    : the app flow changed fundamentally — a single locator fix will NOT work
- ABORT        : this is a genuine product defect or unrecoverable automation failure

═══════════════════════════════════════════════════════════
LOCATOR SELECTION RULES — RANKED BY RESILIENCE:
═══════════════════════════════════════════════════════════
When selecting a HEAL_LOCATOR expression, ALWAYS prefer:
  1. data-testid attributes:  getByTestId('submit-btn')
  2. Semantic role + name:    getByRole('button', {name:'Create'})
  3. Label text:              getByLabel('Collection Name')
  4. Placeholder text:        getByPlaceholder('Enter name...')
  5. Visible text:            getByText('Save', {exact:true})
  6. Stable attribute:        locator('[aria-label="Close"]')
  7. XPath with text:         locator('xpath=//button[normalize-space()="Save"]')

NEVER select (or suggest) these broken patterns:
  ✗ #mantine-[a-z0-9]+   — Mantine auto-generated IDs, change on every render
  ✗ #ruid-[a-z0-9]+      — React UUID auto-generated IDs
  ✗ #react-select-[0-9]+ — React Select auto-generated IDs
  ✗ :nth-child() or [n]  — positional selectors break when items are added/removed
  ✗ bare .className       — too many matches, unstable across UI changes

If the original broken locator IS one of these forbidden patterns, treat any candidate
that fixes it with a semantic or role-based expression as the CORRECT choice, even if
its confidence score is slightly lower — semantic beats brittle every time.

BUSINESS CONTEXT REASONING:
Think about WHAT the test is trying to do (the intentPhrase tells you).
A "fill description" intent → look for textarea/input elements with description-related labels.
A "check item" intent → look for checkbox elements (role=checkbox or input[type=checkbox]).
A "click create" intent → look for button elements with "create" text or role=button.

MANTINE COMPONENT PATTERNS (important for this application):
- Mantine TextInput renders as: input[type="text"] with aria-label or placeholder
- Mantine Textarea renders as: textarea with aria-label or placeholder
- Mantine Checkbox renders as: input[type="checkbox"] wrapped in label
- All Mantine IDs like "#mantine-XXXX" change on each render → never use them

═══════════════════════════════════════════════════════════
OUTPUT FORMAT — JSON ONLY, no prose outside the JSON block:
═══════════════════════════════════════════════════════════
{
  "decision": "HEAL_LOCATOR",
  "expression": "getByLabel('Description')",
  "confidence": 0.92,
  "reasoning": "one sentence: why this expression is the best choice"
}

Rules:
- expression: required for HEAL_LOCATOR only; write as a Playwright method call without 'page.' prefix
- confidence: 0.0–1.0
- reasoning: one sentence, max 100 chars — helps humans understand the choice
- For HEAL_FLOW / ABORT: omit expression, set confidence to 0`;

interface LLMInput {
  failureType: string;
  action: string;
  intentPhrase: string;
  originalLocator: string;
  pageUrl?: string;
  previousStep?: string;
  isForbiddenLocator?: boolean;
  candidates: Array<{
    rank: number;
    expression: string;
    confidence: number;
    reason: string;
  }>;
}

export interface LLMDecision {
  decision: HealingDecision;
  expression?: string;
  confidence: number;
  tokensUsed: number;
  reasoning?: string;
}

/** Returns true if the locator is an auto-generated dynamic ID that should never be used */
function isForbiddenDynamicLocator(locator: string): boolean {
  return /[#[]id[^=]*=.*mantine-[a-z0-9]{6,}|#mantine-|#ruid-|#react-select-[0-9]|#rc_/.test(locator);
}

export async function askLLMForDecision(
  stepInfo: FailedStepInfo,
  failureType: string,
  candidates: LocatorCandidate[],
  previousStepHint?: string,
  model?: string,
  pageUrl?: string,
): Promise<LLMDecision | null> {
  const forbidden = isForbiddenDynamicLocator(stepInfo.locator);

  const payload: LLMInput = {
    failureType,
    action: stepInfo.action,
    intentPhrase: stepInfo.intentPhrase,
    originalLocator: stepInfo.locator,
    pageUrl,
    previousStep: previousStepHint,
    isForbiddenLocator: forbidden || undefined,
    candidates: candidates.slice(0, 8).map((c, i) => ({
      rank: i + 1,
      expression: c.expression,
      confidence: parseFloat(c.confidence.toFixed(2)),
      reason: c.reason,
    })),
  };

  const userMessage = JSON.stringify(payload, null, 0);

  try {
    const client = createAnthropicClient();
    const resolvedModel = resolveModel(model);

    const response = await client.messages.create({
      model: resolvedModel,
      max_tokens: 256,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMessage }],
    });

    const tokensUsed = (response.usage?.input_tokens ?? 0) + (response.usage?.output_tokens ?? 0);
    const raw = response.content[0]?.type === 'text' ? response.content[0].text.trim() : '';

    // Strip markdown fences if present
    const json = raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
    const parsed = JSON.parse(json);

    if (!parsed.decision) return null;

    return {
      decision: parsed.decision as HealingDecision,
      expression: parsed.expression ?? undefined,
      confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0,
      tokensUsed,
      reasoning: parsed.reasoning ?? undefined,
    };
  } catch {
    return null;
  }
}
