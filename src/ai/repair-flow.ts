// AI agent that repairs failing Playwright tests using 3 escalating strategies.
// Strategy 1: Locator fix — find correct selectors for broken elements.
// Strategy 2: Flow analysis — navigate the full flow, fix logic + selectors using MD requirements.
// Strategy 3: Full regeneration — rewrite POM + spec completely from scratch using MD requirements.
import Anthropic from '@anthropic-ai/sdk';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createPlaywrightMcpServer } from '../mcp/playwright-mcp-server';
import { createAnthropicClient, resolveModel, supportsThinking } from './anthropic-client';
import { trackTokens } from '../utils/token-counter';
import fs from 'fs/promises';
import path from 'path';

export interface RepairFlowOptions {
  specPath:          string;
  url:               string;
  errorOutput:       string;
  pomPaths?:         string[];
  headless?:         boolean;
  model?:            string;
  verbose?:          boolean;
  maxTurns?:         number;
  // Escalation context
  mdRequirements?:   string;    // Full MD flow description — source of truth for intent
  attemptNumber?:    number;    // 1, 2, or 3 — controls which strategy to use
  previousErrors?:   string[];  // Errors from prior attempts (passed to next for context)
}

export interface FixedFile {
  path:       string;
  backupPath: string;
}

export interface RepairFlowResult {
  specPath:     string;
  fixed:        boolean;
  turnsUsed:    number;
  backupPath?:  string;
  fixedFiles:   FixedFile[];
  strategyUsed: string;
}

type McpContentBlock = { type: string; text?: string; data?: string; mimeType?: string };

// Use streaming to avoid the 10-minute API timeout.
async function streamMessage(
  anthropic: Anthropic,
  params: Anthropic.MessageCreateParamsNonStreaming,
): Promise<Anthropic.Message> {
  return anthropic.messages.stream(params as Parameters<typeof anthropic.messages.stream>[0]).finalMessage();
}

// How many lines shorter a generated file may be vs the existing one before
// we reject the write as a likely AI truncation (e.g. "rest unchanged" note).
const POM_TRUNCATION_THRESHOLD = 0.5; // new code < 50 % of original → reject

interface FixedFile_      { filePath: string; code: string }
interface PomPatch_       { filePath: string; methods: string }
interface PomReplace_     { filePath: string; methods: string }
interface ParsedOutput    { replacements: FixedFile_[]; pomPatches: PomPatch_[]; pomReplaces: PomReplace_[] }

/**
 * Parse all output blocks from a repair agent response.
 *
 * Handles three formats:
 *   // FILE:   path  →  full file replacement (spec only — POM replacements are safety-checked)
 *   // ADD TO: path  →  patch new methods into an existing POM via applyPomPatch
 *   Fallback:         →  last/only block assumed to be spec fix
 */
function parseRepairOutput(
  outputText:  string,
  specPath:    string,
  projectRoot: string,
): ParsedOutput {
  const replacements: FixedFile_[]  = [];
  const pomPatches:   PomPatch_[]   = [];
  const pomReplaces:  PomReplace_[] = [];

  // 0. // REPLACE IN: blocks — replace existing method bodies (for broken-locator fixes)
  //    Unlike ADD TO, these bypass deduplication and overwrite the existing method.
  const replaceInRe = /```(?:typescript|ts)\n\/\/\s*REPLACE\s+IN\s*:\s*(.+?)\n([\s\S]*?)```/g;
  for (const m of outputText.matchAll(replaceInRe)) {
    const relPath  = m[1].trim();
    const methods  = m[2].replace(/\/\/\s*REPLACE\s+IN\s*:.*$/gim, '').trim();
    const filePath = path.isAbsolute(relPath) ? relPath : path.resolve(projectRoot, relPath);
    pomReplaces.push({ filePath, methods });
  }

  // 1. // ADD TO: blocks — method patches for existing POM files
  const addToRe = /```(?:typescript|ts)\n\/\/\s*ADD\s+TO\s*:\s*(.+?)\n([\s\S]*?)```/g;
  for (const m of outputText.matchAll(addToRe)) {
    const relPath  = m[1].trim();
    const methods  = m[2].replace(/\/\/\s*ADD\s+TO\s*:.*$/gim, '').trim();
    const filePath = path.isAbsolute(relPath) ? relPath : path.resolve(projectRoot, relPath);
    pomPatches.push({ filePath, methods });
  }

  // 2. // FILE: blocks — full replacements (safe for spec; guarded for POM)
  const fileBlockRe = /```(?:typescript|ts)\n\/\/\s*FILE:\s*(.+?)\n([\s\S]*?)```/g;
  for (const m of outputText.matchAll(fileBlockRe)) {
    const relPath  = m[1].trim();
    const code     = m[2].trim();
    const filePath = path.isAbsolute(relPath) ? relPath : path.resolve(projectRoot, relPath);

    // Safety guard: never overwrite a large existing POM with an AI-truncated fragment.
    // The AI often writes just the new/changed methods with a comment like
    // "// NOTE: The remainder is unchanged" — this would destroy the original file.
    if (isPomFile(filePath)) {
      let existingLines = 0;
      try {
        const existing = require('fs').readFileSync(filePath, 'utf-8') as string;
        existingLines  = existing.split('\n').length;
      } catch { /* file does not exist yet — safe to create */ }

      if (existingLines > 200) {
        const newLines = code.split('\n').length;
        if (newLines / existingLines < POM_TRUNCATION_THRESHOLD) {
          // Looks like a truncated replacement — treat it as a patch instead.
          console.warn(
            `[Repair] WARN: ${path.relative(projectRoot, filePath)} — ` +
            `generated ${newLines} lines vs existing ${existingLines}. ` +
            `Treating as ADD TO patch instead of full replacement.`,
          );
          // Strip class wrapper if present, keep only the method bodies for patching.
          const methodsOnly = code
            .replace(/^import\s+.*;\n?/gm, '')
            .replace(/^export\s+(?:default\s+)?class\s+\w+[^{]*\{/, '')
            .replace(/\}\s*$/, '')
            .replace(/\/\/\s*NOTE:.*$[\s\S]*$/m, '') // strip "NOTE: remainder unchanged" noise
            .trim();
          pomPatches.push({ filePath, methods: methodsOnly });
          continue;
        }
      }
    }

    replacements.push({ filePath, code });
  }

  if (replacements.length > 0 || pomPatches.length > 0 || pomReplaces.length > 0) return { replacements, pomPatches, pomReplaces };

  // 3. Fallback: no FILE:/ADD TO: markers found.
  //    Only use when there is exactly one block (avoids mis-taking a POM block as spec).
  const allBlocks = [...outputText.matchAll(/```(?:typescript|ts)\n([\s\S]*?)```/g)];
  if (allBlocks.length === 1) {
    replacements.push({ filePath: path.resolve(specPath), code: allBlocks[0][1].trim() });
  } else if (allBlocks.length > 1) {
    const specLike = allBlocks.find(b => b[1].includes('test.describe') || b[1].includes('test('));
    if (specLike) replacements.push({ filePath: path.resolve(specPath), code: specLike[1].trim() });
  }
  return { replacements, pomPatches, pomReplaces };
}

function isPomFile(filePath: string): boolean {
  const rel = filePath.replace(/\\/g, '/');
  return rel.includes('/src/pages/') || rel.includes('\\src\\pages\\');
}

// ── Adaptive helpers ───────────────────────────────────────────────────────────

/**
 * Adaptive token ceiling for repair turns.
 * Repair is more focused than generation — intermediate turns just call browser
 * tools; only the final code output turn needs a large window.
 */
function adaptiveMaxTokens(turn: number, maxTurns: number): number {
  if (turn >= Math.floor(maxTurns * 0.8)) return 16384; // writing fixed code
  if (turn === 1) return 8192;                           // initial analysis
  return 3072;                                            // tool-call turns
}

/**
 * Extract the ~50-line window around the failing line from a POM file.
 * Used for Strategy 1 (locator-fix) to send only the broken method instead
 * of the full POM (which can be thousands of lines).
 */
function extractFailingContext(content: string, errorStack: string, maxLines = 55): string {
  const lineMatch = errorStack.match(/:(\d+):\d+[\)>]/);
  if (!lineMatch) return content.slice(0, 2000);

  const targetLine = parseInt(lineMatch[1], 10) - 1; // 0-indexed
  const lines      = content.split('\n');
  if (targetLine < 0 || targetLine >= lines.length) return content.slice(0, 2000);

  // Walk backwards to find the enclosing method signature
  let methodStart = Math.max(0, targetLine - 5);
  for (let i = targetLine; i >= Math.max(0, targetLine - 40); i--) {
    if (/^\s*(async\s+\w+|private\s+async|public\s+async|protected\s+async|\w+\s*\(.*\)\s*:\s*Promise)/.test(lines[i])) {
      methodStart = Math.max(0, i - 1);
      break;
    }
  }

  // Walk forwards to find the closing brace of the method
  let methodEnd   = Math.min(lines.length - 1, methodStart + maxLines);
  let braceDepth  = 0;
  let foundOpen   = false;
  for (let i = methodStart; i <= methodStart + maxLines && i < lines.length; i++) {
    for (const ch of lines[i]) {
      if (ch === '{') { braceDepth++; foundOpen = true; }
      else if (ch === '}') braceDepth--;
    }
    if (foundOpen && braceDepth <= 0) { methodEnd = i; break; }
  }

  return lines.slice(methodStart, methodEnd + 1).join('\n');
}

// ── Strategy system prompts ────────────────────────────────────────────────────

function buildStrategy1Prompt(): string {
  return `You are a WORLD-CLASS QA AUTOMATION ENGINEER specializing in Playwright test repair.
You have deep expertise in enterprise web applications and UI component libraries.

═══ STRATEGY 1: SURGICAL LOCATOR REPAIR ═══

Your single goal: navigate to the EXACT failing step, find the element that is broken,
verify the CORRECT selector exists in the live DOM, and update ONLY that selector.

CRITICAL MINDSET — THINK LIKE AN EXPERIENCED QA:
- Understand WHAT the test is trying to do (read the error + intent carefully)
- Think about WHY the locator broke: UI library update? Component re-render? Page restructure?
- Think about WHICH element semantically represents that action in this context

FORBIDDEN LOCATOR PATTERNS — NEVER USE IN GENERATED CODE:
  ✗ #mantine-[a-z0-9]+   (Mantine auto-IDs — change on EVERY render)
  ✗ #ruid-[a-z0-9]+      (React UUID auto-IDs)
  ✗ #react-select-[0-9]+ (React Select auto-IDs)
  ✗ :nth-child()          (positional — breaks on DOM changes)
  ✗ bare .className       (matches multiple elements)

If the broken locator IS one of these forbidden patterns, that is the ROOT CAUSE.
You MUST find a semantic replacement, in this priority:
  1. page.getByTestId('...')                    ← best
  2. page.getByRole('textbox', {name:'Label'})  ← semantic
  3. page.getByLabel('Label Text')              ← form fields
  4. page.getByPlaceholder('Hint text')         ← inputs without label
  5. page.getByText('Visible text', {exact:true})
  6. page.locator('[aria-label*="..." i]')
  7. page.locator('xpath=//tag[@attr="value"]') ← XPath only if verified

MANTINE COMPONENT HEALING GUIDE:
  Broken: #mantine-5sdvkuk6v  (auto-generated Mantine input ID)
  → For TextInput/Textarea:  page.getByRole('textbox', { name: 'Field Label' })
                              page.getByLabel('Field Label')
                              page.getByPlaceholder('placeholder text')
  Broken: #mantine-24784d2jy  (auto-generated Mantine checkbox ID)
  → For Checkbox:  page.getByRole('checkbox', { name: 'Item Name' })
                   page.locator('label:has-text("Item Name") input[type="checkbox"]')

REPAIR PROCESS:
1. Read the error carefully — identify WHICH step/method is failing and WHY
2. browser_navigate → go to the URL
3. If not authenticated: look for sign-in form and log in
4. Replay steps up to the failure point
5. At the failing element:
   a. Run TARGETED browser_query_all queries in priority order:
      → browser_query_all [data-testid*="relevant-name"]
      → browser_query_all button:has-text("Text") or [role="button"]:has-text("Text")
      → browser_query_all [aria-label*="name" i]
      → browser_query_all [placeholder*="name" i]
      → browser_query_all [role="textbox"][aria-label*="name" i]
   b. Use the FIRST selector that returns EXACTLY 1 element
   c. For Mantine textareas/inputs: NEVER use the #mantine-* id, use getByLabel or getByRole
   d. For checkboxes: look for role="checkbox" or input[type="checkbox"] with scoped label
6. Verify the chosen selector: browser_query_all <selector> → must return count=1

CRITICAL OUTPUT RULES:
⚠ For the SPEC file: output COMPLETE spec with ONLY the corrected selector(s).
⚠ For a POM file: NEVER output the full POM.
  Use directives:
  // FILE:       for the spec (always complete)
  // REPLACE IN: for an EXISTING POM method with a broken locator (replaces its body)
  // ADD TO:     for a NEW method that doesn't exist yet (adds to the class)

\`\`\`typescript
// FILE: tests/generated/xxx.spec.ts
import test, { expect } from '../../src/fixtures/pageObjects';
import ENV from '../../src/utils/env';
// ... COMPLETE spec file ...
\`\`\`

\`\`\`typescript
// REPLACE IN: src/pages/XxxPage.ts
// [AI-fixed] — replaced Mantine auto-ID with stable semantic locator
async fillDescriptionField(description: string): Promise<void> {
  await this.page.getByLabel('Description').fill(description);
}
\`\`\`

\`\`\`typescript
// ADD TO: src/pages/XxxPage.ts
// [AI-fixed] — new method with verified stable selector
async checkFirstContentItem(): Promise<void> {
  await this.page.getByRole('checkbox').first().check();
}
\`\`\`

WHEN TO USE REPLACE IN vs ADD TO:
- Method EXISTS in POM with broken/dynamic locator → use REPLACE IN
- Method DOES NOT EXIST in POM → use ADD TO
- Selector property in a group is wrong → use REPLACE IN on the method that references it`;
}

function buildStrategy2Prompt(mdRequirements: string, previousErrors: string[]): string {
  const prevSummary = previousErrors.length > 0
    ? `\nWHAT FAILED IN PREVIOUS ATTEMPT:\n${previousErrors.map((e, i) => `Attempt ${i + 1}: ${e.slice(0, 300)}`).join('\n')}\n`
    : '';

  return `You are a SENIOR QA AUTOMATION ENGINEER analyzing a test that failed even after a locator fix.
This requires a deeper flow-level analysis — understanding the APPLICATION BEHAVIOR, not just selectors.

═══ STRATEGY 2: FLOW ANALYSIS & BUSINESS LOGIC REPAIR ═══
${prevSummary}
ORIGINAL REQUIREMENTS (the source of truth — what this test SHOULD do):
───────────────────────────────────────────────────────────
${mdRequirements}
───────────────────────────────────────────────────────────

SENIOR QA MINDSET — THINK LIKE AN EXPERIENCED TESTER WHO KNOWS THE APP:
- Read the requirements line by line — understand each step's BUSINESS PURPOSE
- Look at the error — understand WHERE the app diverges from expected behavior
- Think: is this an automation bug (wrong step order, wrong wait, wrong locator)?
         Or is this an app bug (feature missing, regression, broken flow)?
- Walk the app like a human QA: authenticate, navigate, execute each step, observe

FORBIDDEN LOCATOR PATTERNS — DO NOT USE IN REPAIRED CODE:
  ✗ #mantine-[a-z0-9]+   (Mantine auto-IDs, change every render)
  ✗ #ruid-[a-z0-9]+      (React UUID auto-IDs)
  ✗ #react-select-[0-9]+ (React Select auto-IDs)
  ✗ :nth-child() positional selectors
  Any ID with 6+ alphanumeric chars that looks like a hash = auto-generated = forbidden.

MANTINE COMPONENT PATTERNS (this app uses Mantine UI heavily):
  TextInput/Textarea: use page.getByLabel() or page.getByRole('textbox', {name:'...'})
  Checkbox:          use page.getByRole('checkbox', {name:'...'}) or label:has-text() scope
  Select/Combobox:   use page.getByRole('combobox') or page.locator('[role="option"]')
  Button:            use page.getByRole('button', {name:'...'})

REPAIR PROCESS:
1. Read requirements — build a mental model of the COMPLETE flow
2. Read the error — identify WHERE and WHY it breaks
3. browser_navigate → go to the URL
4. Authenticate if needed (look for sign-in form, use provided credentials)
5. Execute the COMPLETE flow step by step:
   - For EACH step: browser_query_all targeted selector → verify count=1
   - After EACH navigation: browser_get_url to confirm correct page
   - After EACH modal open: verify [role="dialog"] count > 0
   - Note differences between what code does and what app expects
6. Identify root cause: timing? wrong selector? wrong URL? missing step?
7. Fix the spec and any POM methods that are broken

COMMON FLOW ISSUES TO INVESTIGATE:
  Auth:      App redirects directly without login form → detect and handle both cases
  Timing:    Element not ready → add waitForSelector or waitForLoadState
  Modals:    Wrong modal scope → scope queries to [role="dialog"]
  State:     Button disabled until form valid → fill all required fields first
  Navigation: Wrong URL path → check and fix visitXxx() methods
  Dynamic IDs: Mantine auto-IDs changed → replace with getByLabel/getByRole

MANDATORY FRAMEWORK PATTERNS:
  ⚠ Import:   import test, { expect } from '../../src/fixtures/pageObjects';
  ⚠ Import:   import ENV from '../../src/utils/env';
  ⚠ NEVER:    import { test, expect } from '@playwright/test';
  ⚠ Fixture:  async ({ page, loginPage, xPage }) =>  // NEVER new XxxPage(page)
  ⚠ Auth:     await loginPage.loginToApplication(ENV.BASE_URL);
  ⚠ URLs:     await this.page.goto(\`\${process.env.BASE_URL}/path\`);  // NEVER hardcode

OUTPUT FORMAT:
\`\`\`typescript
// FILE: tests/generated/xxx.spec.ts
import test, { expect } from '../../src/fixtures/pageObjects';
import ENV from '../../src/utils/env';

test.describe('Feature @tag', { tag: ['@tag'] }, () => {
  test.use({ viewport: { width: 1920, height: 1080 } });
  test('should complete flow', async ({ page, loginPage, relevantPage }) => {
    test.setTimeout(300_000);
    // ... complete fixed spec ...
  });
});
\`\`\`

\`\`\`typescript
// REPLACE IN: src/pages/XxxPage.ts
// [AI-fixed] — corrected broken selector
async fillDescriptionField(description: string): Promise<void> {
  await this.page.getByLabel('Description').fill(description);
}
\`\`\`

Rules:
- // FILE: for spec (ALWAYS complete). // REPLACE IN: for existing broken method. // ADD TO: for new method.
- // REPLACE IN: and // ADD TO: MUST reference an EXISTING src/pages/ file.
- New selectors MUST be verified with browser_query_all during exploration.
- NEVER output a full POM class file.`;
}

function buildStrategy3Prompt(mdRequirements: string, previousErrors: string[]): string {
  const prevSummary = previousErrors.length > 0
    ? `\nFAILED ATTEMPT ERRORS:\n${previousErrors.map((e, i) => `Attempt ${i + 1}: ${e.slice(0, 400)}`).join('\n')}\n`
    : '';

  return `You are a PRINCIPAL QA AUTOMATION ARCHITECT. Two previous repair attempts have failed.
You must do a COMPLETE FRESH REGENERATION — navigate the app yourself, execute every step,
and rewrite this test from scratch based on VERIFIED selectors from the live app.

═══ STRATEGY 3: COMPLETE FRESH REGENERATION ═══
${prevSummary}
ORIGINAL REQUIREMENTS — implement these exactly (this is the CONTRACT):
───────────────────────────────────────────────────────────
${mdRequirements}
───────────────────────────────────────────────────────────

ARCHITECT MINDSET:
- Previous attempts failed for a reason. Read the errors carefully before starting.
- The spec must match EXACTLY what the live app does, not what the code assumed.
- You are building production-quality automation that must survive long-term.
- Think about every edge case: timing, auth state, modal sequences, dynamic content.

FORBIDDEN LOCATOR PATTERNS — ABSOLUTELY NEVER USE:
  ✗ #mantine-[a-z0-9]+   — Mantine UI auto-IDs, DIFFERENT on every page load
  ✗ #ruid-[a-z0-9]+      — React UUID auto-IDs, DIFFERENT on every render
  ✗ #react-select-[0-9]+ — React Select auto-IDs
  ✗ :nth-child(n)         — positional, breaks when DOM changes
  ✗ bare .className       — too many matches

  IF you see any of these patterns in the broken test — THAT WAS THE ROOT CAUSE.
  Use semantic locators: getByRole, getByLabel, getByTestId, getByPlaceholder.

MANTINE UI HEALING GUIDE (this app uses Mantine v6+):
  Mantine TextInput:
    ✓ page.getByRole('textbox', { name: 'Field Label' })
    ✓ page.getByLabel('Field Label')
    ✓ page.getByPlaceholder('Enter text...')
    ✗ NEVER: page.locator('#mantine-xxxxxxxx')

  Mantine Textarea:
    ✓ page.getByRole('textbox', { name: 'Description' })
    ✓ page.getByLabel('Description')
    ✓ page.locator('textarea[aria-label*="description" i]')
    ✗ NEVER: page.locator('#mantine-xxxxxxxx')

  Mantine Checkbox:
    ✓ page.getByRole('checkbox', { name: 'Item Name' })
    ✓ page.locator('label:has-text("Item Name") input[type="checkbox"]')
    ✓ page.locator('xpath=//label[normalize-space()="Item Name"]//input[@type="checkbox"]')
    ✗ NEVER: page.locator('#mantine-xxxxxxxx').check()

  Mantine Select/Combobox:
    ✓ page.getByRole('combobox', { name: 'Field Label' })
    ✓ page.getByRole('option', { name: 'Option Text' })
    ✗ NEVER: page.locator('#react-select-1')

FRESH EXPLORATION PROTOCOL:

PHASE 1 — AUTHENTICATE
  1. browser_navigate → URL
  2. browser_get_url → confirm where we landed
  3. If at login page: browser_query_all [type="email"],[type="text"],[name="email"]
     Fill credentials → submit → wait for redirect
  4. browser_get_url → confirm dashboard URL

PHASE 2 — MAP THE FLOW (before executing)
  For each requirement step, identify:
    - action: click | fill | select | navigate | verify | wait
    - target: what element? what text? what role?
    - context: page? modal? dropdown? wizard step?
    - selector strategy: what getByRole/getByLabel/getByTestId will find it?

PHASE 3 — EXECUTE ALL STEPS WITH VERIFIED SELECTORS
  ⚠ EVERY step from requirements MUST be executed and verified in the browser.
  ⚠ For EVERY element: browser_query_all → must return count=1 before use.
  ⚠ For EVERY modal: verify [role="dialog"] count > 0 before querying inside.
  ⚠ After EVERY navigation: browser_get_url → verify correct page.

  Selector discovery order:
    1. browser_query_all [data-testid*="keyword"]
    2. browser_query_all [role="button"]:has-text("Label")  or  button:has-text("Label")
    3. browser_query_all [aria-label*="label" i]  or  [placeholder*="label" i]
    4. browser_get_content → identify element from structure
    5. XPath only as last resort — MUST verify count=1 with browser_query_all

PHASE 4 — WRITE VERIFIED CODE
  Every selector in your code MUST be one you verified in Phase 3.
  Every step MUST be implemented.

MANDATORY FRAMEWORK PATTERNS:
  ⚠ Import:   import test, { expect } from '../../src/fixtures/pageObjects';
  ⚠ Import:   import ENV from '../../src/utils/env';
  ⚠ NEVER:    import { test, expect } from '@playwright/test';
  ⚠ NEVER:    new XxxPage(page) — use fixture injection
  ⚠ Auth:     await loginPage.loginToApplication(ENV.BASE_URL);
  ⚠ URLs:     Use ENV.BASE_URL — NEVER hardcode URL strings in specs
  ⚠ Viewport: test.use({ viewport: { width: 1920, height: 1080 } });
  ⚠ Timeout:  test.setTimeout(300_000);

OUTPUT FORMAT — spec is ALWAYS complete; POM uses REPLACE IN or ADD TO only:
\`\`\`typescript
// FILE: tests/generated/xxx.spec.ts
import test, { expect } from '../../src/fixtures/pageObjects';
import ENV from '../../src/utils/env';

test.describe('Feature @tag', { tag: ['@tag'] }, () => {
  test.use({ viewport: { width: 1920, height: 1080 } });

  test('should complete flow end-to-end', { tag: ['@tag'] },
    async ({ page, loginPage, relevantPage }) => {
      test.setTimeout(300_000);

      await test.step('Authenticate and navigate', async () => {
        await loginPage.loginToApplication(ENV.BASE_URL);
        await relevantPage.visit();
        await expect(page).toHaveURL(/expected-path/, { timeout: 15_000 });
      });

      await test.step('Execute main flow', async () => {
        await expect(page.getByRole('button', { name: 'Create' })).toBeVisible({ timeout: 10_000 });
        await relevantPage.clickCreateButton();
        await expect(page.getByRole('dialog')).toBeVisible({ timeout: 10_000 });
      });

      await test.step('Verify business outcome', async () => {
        await page.waitForLoadState('domcontentloaded', { timeout: 8_000 }).catch(() => {});
        await expect(page).toHaveURL(/result-path/, { timeout: 15_000 });
        await expect(page.locator('[data-testid="success-element"]')).toBeVisible({ timeout: 10_000 });
        await page.screenshot({ path: 'test-results/final-state.png', fullPage: true });
      });
    }
  );
});
\`\`\`

\`\`\`typescript
// REPLACE IN: src/pages/XxxPage.ts
// [AI-regenerated] — verified selector from live app
async fillDescriptionField(description: string): Promise<void> {
  await this.page.getByLabel('Description').fill(description);
}
\`\`\`

\`\`\`typescript
// ADD TO: src/pages/XxxPage.ts
// [AI-regenerated]
async checkFirstContentItem(): Promise<void> {
  await this.page.getByRole('checkbox').first().check();
}
\`\`\`

RULES:
- // FILE: for spec (COMPLETE file always)
- // REPLACE IN: for existing broken methods (NEVER the full class)
- // ADD TO: for new methods (NEVER the full class, MUST be an existing src/pages/ file)
- Every selector MUST be verified count=1 in the browser during Phase 3
- NEVER use Mantine/React auto-generated IDs
- Use unique names for created items: include Date.now() to avoid collisions
- NEVER use waitForLoadState('networkidle') — use 'domcontentloaded'`;
}

// ── Agent loop ─────────────────────────────────────────────────────────────────

async function runRepairLoop(
  anthropic:      Anthropic,
  mcpClient:      Client,
  anthropicTools: Anthropic.Tool[],
  systemPrompt:   string,
  userPrompt:     string,
  model:          string,
  maxTurns:       number,
  log:            (msg: string) => void,
): Promise<string> {
  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: userPrompt }];
  let outputText = '';

  // Inject nudges at 60% and 85% of the turn budget to prevent Claude from
  // exhausting turns while still exploring without producing fixed code.
  const nudgeTurn60 = Math.max(3, Math.floor(maxTurns * 0.60));
  const nudgeTurn85 = Math.max(4, Math.floor(maxTurns * 0.85));

  for (let turn = 1; turn <= maxTurns; turn++) {
    log(`[Repair] Turn ${turn}/${maxTurns}...`);

    const params: Anthropic.MessageCreateParamsNonStreaming = {
      model,
      max_tokens: adaptiveMaxTokens(turn, maxTurns),
      system:     systemPrompt,
      tools:      anthropicTools,
      messages,
    };
    // Enable thinking only on the first turn (understanding the error) and
    // the final code-generation turns. Intermediate tool-call turns skip thinking.
    const useThinking = (turn === 1 || turn >= Math.floor(maxTurns * 0.8)) && supportsThinking(model);
    if (useThinking) {
      (params as unknown as Record<string, unknown>).thinking = { type: 'enabled', budget_tokens: 8000 };
    }

    const t0 = Date.now();
    const response = await streamMessage(anthropic, params);
    if (response.usage) {
      trackTokens('repair', response.usage.input_tokens, response.usage.output_tokens, Date.now() - t0);
    }
    messages.push({ role: 'assistant', content: response.content });

    for (const block of response.content) {
      if (block.type === 'text') outputText += block.text;
    }

    if (response.stop_reason === 'end_turn') {
      log('[Repair] Claude finished analysis.');
      break;
    }

    if (response.stop_reason !== 'tool_use') break;

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const block of response.content) {
      if (block.type !== 'tool_use') continue;
      log(`  → ${block.name}(${JSON.stringify(block.input).slice(0, 100)})`);
      try {
        const mcpResult  = await mcpClient.callTool({ name: block.name, arguments: block.input as Record<string, unknown> });
        const mcpContent = (mcpResult.content ?? []) as McpContentBlock[];
        const resultContent: Array<Anthropic.TextBlockParam | Anthropic.ImageBlockParam> = [];
        for (const c of mcpContent) {
          if (c.type === 'text' && c.text != null)
            resultContent.push({ type: 'text', text: c.text });
          else if (c.type === 'image' && c.data != null)
            resultContent.push({ type: 'image', source: { type: 'base64', media_type: (c.mimeType || 'image/jpeg') as 'image/jpeg' | 'image/png', data: c.data } });
        }
        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: resultContent, is_error: mcpResult.isError === true });
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        log(`  [error] ${block.name}: ${errMsg}`);
        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: [{ type: 'text', text: `Tool error: ${errMsg}` }], is_error: true });
      }
    }

    // Build the user message: tool results + optional turn nudge.
    // The nudge is appended as a text block inside the same user message so
    // Claude receives it before its next API call (avoiding consecutive user messages).
    let nudgeText: string | null = null;
    if (turn === nudgeTurn60) {
      nudgeText = `[Turn ${turn}/${maxTurns} — 60% of budget used]\n` +
        `You should have gathered enough information. Now transition to writing the fix.\n` +
        `Finish any last observation in one step, then output ALL complete fixed TypeScript files using the // FILE: format.\n` +
        `Do not continue exploring — write the code.`;
      log(`[Repair] Injecting 60% nudge at turn ${turn}`);
    } else if (turn === nudgeTurn85) {
      nudgeText = `[Turn ${turn}/${maxTurns} — CRITICAL: 85% of budget used]\n` +
        `STOP all browser tool use immediately. You must write the fixed TypeScript code RIGHT NOW.\n` +
        `Output ALL complete fixed files using the // FILE: format. This is mandatory — ` +
        `if you call any more browser tools instead of writing code, the healing will fail and the test will remain broken.\n` +
        `Write complete files. Do not truncate.`;
      log(`[Repair] Injecting 85% nudge at turn ${turn}`);
    }

    if (toolResults.length > 0) {
      // Merge nudge text into the same user message as tool results so the
      // conversation stays valid (no two consecutive user messages).
      const content: Anthropic.ContentBlockParam[] = [...toolResults];
      if (nudgeText) content.push({ type: 'text', text: nudgeText });
      messages.push({ role: 'user', content });
    } else if (nudgeText) {
      messages.push({ role: 'user', content: nudgeText });
    }
  }

  return outputText;
}

// ── Main export ────────────────────────────────────────────────────────────────

export async function repairFlow(options: RepairFlowOptions): Promise<RepairFlowResult> {
  const {
    specPath,
    url,
    errorOutput,
    pomPaths    = [],
    headless    = true,
    verbose     = true,
    mdRequirements,
    attemptNumber  = 1,
    previousErrors = [],
  } = options;

  const model      = resolveModel(options.model);
  const log        = (msg: string) => { if (verbose) console.log(msg); };
  const projectRoot = path.resolve(process.cwd());
  const absSpecPath = path.resolve(specPath);

  // Turn budgets are intentionally leaner than the original (20/50/100):
  // - Strategy 1 (locator fix): 12 turns is enough to navigate + query + fix one selector
  // - Strategy 2 (flow analysis): 30 turns covers a full multi-step flow replay
  // - Strategy 3 (regeneration): 60 turns for a full exploration + code write
  const maxTurns = options.maxTurns ?? (attemptNumber === 1 ? 12 : attemptNumber === 2 ? 30 : 60);

  const strategyNames = ['locator-fix', 'flow-fix', 'full-regeneration'];
  const strategyName  = strategyNames[Math.min(attemptNumber - 1, 2)];

  log(`\n[Repair] Attempt ${attemptNumber}/3 — Strategy: ${strategyName}`);
  log(`[Repair] Target URL: ${url}`);
  log(`[Repair] Max turns: ${maxTurns}`);

  const specContent = await fs.readFile(absSpecPath, 'utf-8').catch(() => '');
  const pomContents: Array<{ relPath: string; content: string }> = [];
  for (const p of pomPaths) {
    try {
      const absP    = path.resolve(p);
      const content = await fs.readFile(absP, 'utf-8');
      pomContents.push({ relPath: path.relative(projectRoot, absP), content });
    } catch { log(`[Repair] Warning: could not read POM file: ${p}`); }
  }

  const { server: mcpServer, cleanup } = await createPlaywrightMcpServer(headless);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await mcpServer.connect(serverTransport);
  const mcpClient = new Client({ name: 'repair-flow-client', version: '1.0.0' });
  await mcpClient.connect(clientTransport);

  const { tools: mcpTools } = await mcpClient.listTools();
  const anthropicTools: Anthropic.Tool[] = mcpTools.map((tool) => ({
    name:         tool.name,
    description:  tool.description ?? tool.name,
    input_schema: (tool.inputSchema as Anthropic.Tool['input_schema']) ?? { type: 'object', properties: {} },
  }));
  log(`[Repair] ${anthropicTools.length} browser tools available`);

  const anthropic = createAnthropicClient();

  // Pick system prompt based on attempt number
  let systemPrompt: string;
  if (attemptNumber <= 1) {
    systemPrompt = buildStrategy1Prompt();
  } else if (attemptNumber === 2) {
    systemPrompt = buildStrategy2Prompt(
      mdRequirements ?? '(no requirements file found — infer from the spec and error)',
      previousErrors,
    );
  } else {
    systemPrompt = buildStrategy3Prompt(
      mdRequirements ?? '(no requirements file found — use the spec as the source of truth and rebuild it correctly)',
      previousErrors,
    );
  }

  // Strategy 1 sends only the failing method context (50 lines) instead of
  // the full POM — saves thousands of input tokens on large page objects.
  // Strategies 2 and 3 send full files because they need the complete picture.
  const pomSection = pomContents.length > 0
    ? pomContents.map(({ relPath, content }) => {
        const showFull = attemptNumber > 1;
        const excerpt  = showFull ? content : extractFailingContext(content, errorOutput);
        const note     = !showFull && excerpt.length < content.length
          ? `\n[Showing ~${excerpt.split('\n').length} lines around the failure; ${content.split('\n').length} lines total]\n`
          : '';
        return `### ${relPath}${note}\n\`\`\`typescript\n${excerpt}\n\`\`\``;
      }).join('\n\n')
    : '*(no POM files provided)*';

  // Truncate previous errors to 200 chars each — full stack traces add thousands
  // of tokens but contain no extra information useful for the repair agent.
  const previousAttemptsSummary = previousErrors.length > 0
    ? `\n\nPREVIOUS ATTEMPTS:\n${previousErrors.map((e, i) => `Attempt ${i + 1} error: ${e.slice(0, 200)}`).join('\n\n')}\n`
    : '';

  const userPrompt = `Failing test spec: ${path.relative(projectRoot, absSpecPath)}
Target URL: ${url}

CURRENT ERROR:
\`\`\`
${errorOutput || '(no error output provided)'}
\`\`\`
${previousAttemptsSummary}
SPEC FILE:
\`\`\`typescript
${specContent}
\`\`\`

POM FILES:
${pomSection}

Navigate to ${url}, execute the repair strategy described in the system prompt, and output fixed files using // FILE: for the spec and // ADD TO: for any POM method additions.`;

  let outputText = '';
  try {
    outputText = await runRepairLoop(anthropic, mcpClient, anthropicTools, systemPrompt, userPrompt, model, maxTurns, log);
  } finally {
    await mcpClient.close().catch(() => null);
    await cleanup();
  }

  const { replacements, pomPatches, pomReplaces } = parseRepairOutput(outputText, absSpecPath, projectRoot);

  if (replacements.length === 0 && pomPatches.length === 0 && pomReplaces.length === 0) {
    log('[Repair] Claude did not produce any fixed file. Original preserved.');
    return { specPath, fixed: false, turnsUsed: maxTurns, fixedFiles: [], strategyUsed: strategyName };
  }

  const { applyPomPatch, applyPomReplace } = await import('../utils/pom-patcher');
  const fixedFiles: FixedFile[] = [];

  // Apply full replacements (spec file)
  for (const { filePath, code } of replacements) {
    const backupPath = `${filePath}.bak`;
    try {
      const original = await fs.readFile(filePath, 'utf-8');
      await fs.writeFile(backupPath, original, 'utf-8');
    } catch { /* file might not exist yet */ }
    await fs.writeFile(filePath, code, 'utf-8');
    log(`[Repair] Fixed: ${path.relative(projectRoot, filePath)}`);
    fixedFiles.push({ path: filePath, backupPath });
  }

  // Apply REPLACE IN patches — replace existing broken methods (bypasses deduplication)
  for (const { filePath, methods } of pomReplaces) {
    const backupPath = `${filePath}.bak`;
    try {
      const original = await fs.readFile(filePath, 'utf-8');
      await fs.writeFile(backupPath, original, 'utf-8');
    } catch { /* file might not exist yet */ }
    try {
      const result = await applyPomReplace(filePath, methods, log);
      if (result.replaced.length > 0) {
        log(`[Repair] Replaced methods in POM: ${result.replaced.join(', ')} in ${path.relative(projectRoot, filePath)}`);
        fixedFiles.push({ path: filePath, backupPath });
      }
      if (result.notFound.length > 0) {
        log(`[Repair] WARN: methods not found (will try ADD TO): ${result.notFound.join(', ')}`);
        // Fall back to applyPomPatch for methods that don't exist yet
        await applyPomPatch(filePath, methods, log).catch(e =>
          log(`[Repair] WARN: ADD TO fallback failed: ${e instanceof Error ? e.message : e}`));
      }
    } catch (repErr) {
      log(`[Repair] WARN: REPLACE IN failed for ${path.relative(projectRoot, filePath)}: ${repErr instanceof Error ? repErr.message : repErr}`);
    }
  }

  // Apply POM patches via applyPomPatch (never overwrites the whole file)
  for (const { filePath, methods } of pomPatches) {
    const backupPath = `${filePath}.bak`;
    try {
      const original = await fs.readFile(filePath, 'utf-8');
      await fs.writeFile(backupPath, original, 'utf-8');
    } catch { /* file might not exist yet */ }
    try {
      await applyPomPatch(filePath, methods, log);
      log(`[Repair] Patched POM: ${path.relative(projectRoot, filePath)}`);
      fixedFiles.push({ path: filePath, backupPath });
    } catch (patchErr) {
      log(`[Repair] WARN: POM patch failed for ${path.relative(projectRoot, filePath)}: ${patchErr instanceof Error ? patchErr.message : patchErr}`);
    }
  }

  const specFixed = fixedFiles.some((f) => path.resolve(f.path) === absSpecPath);
  return {
    specPath,
    fixed:        fixedFiles.length > 0,
    turnsUsed:    maxTurns,
    backupPath:   specFixed ? `${absSpecPath}.bak` : undefined,
    fixedFiles,
    strategyUsed: strategyName,
  };
}
