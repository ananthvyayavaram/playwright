// AI agent that browses the app via MCP browser tools and generates POM classes + test specs from requirements.
import Anthropic from '@anthropic-ai/sdk';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createPlaywrightMcpServer } from '../mcp/playwright-mcp-server';
import { createAnthropicClient, resolveModel, supportsThinking } from './anthropic-client';
import { trackTokens } from '../utils/token-counter';
import fs from 'fs/promises';
import path from 'path';

export type GenerationMode = 'test' | 'pom';

export interface FlowGeneratorOptions {
  url:              string;
  flowDescription:  string;
  outputDir?:       string;
  headless?:        boolean;
  model?:           string;
  verbose?:         boolean;
  mode?:            GenerationMode;
  maxTurns?:        number;
  tag?:             string;
  username?:        string;
  password?:        string;
  outputFileName?:  string;  // Override the spec filename (e.g. "collections.spec.ts")
}

export interface FlowGeneratorResult {
  outputPath:      string;
  pomPath?:        string;
  actionsRecorded: number;
  turnsUsed:       number;
}

export function toFlowFileName(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
}

function extractAllTypescriptBlocks(text: string): string[] {
  const blocks: string[] = [];
  const re = /```(?:typescript|ts)\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) blocks.push(m[1].trim());
  return blocks;
}

function extractPomBlocks(text: string): { pomCode: string | null; testCode: string } | null {
  const blocks = extractAllTypescriptBlocks(text);

  // Helper: is this block a test spec?
  const isTestBlock = (b: string) =>
    b.includes('test.describe') || b.includes("import test,") || b.includes("import { test");

  // Helper: is this block a POM class or ADD TO addition?
  const isPomBlock = (b: string) =>
    b.includes('// ADD TO:') ||
    b.includes('export class') ||
    (b.includes('async ') && b.includes('this.page') && !isTestBlock(b));

  if (blocks.length >= 2) {
    const pomIdx  = blocks.findIndex(isPomBlock);
    const testIdx = blocks.findIndex(isTestBlock);
    if (pomIdx !== -1 && testIdx !== -1 && pomIdx !== testIdx) {
      return { pomCode: blocks[pomIdx], testCode: blocks[testIdx] };
    }
    // Fallback: first is POM, second is test
    return { pomCode: blocks[0], testCode: blocks[1] };
  }

  // Single block — could be test-only or combined
  if (blocks.length === 1) {
    const code = blocks[0];

    // Combined block with class + test.describe
    const testStart = code.search(/^test\.describe/m);
    if (testStart > 200) {
      return { pomCode: code.slice(0, testStart).trim(), testCode: code.slice(testStart).trim() };
    }

    // Pure test spec — no POM needed
    if (isTestBlock(code)) {
      return { pomCode: null, testCode: code };
    }
  }

  return null;
}

function extractTestCode(text: string): string {
  const blocks = extractAllTypescriptBlocks(text);
  const testBlock = blocks.find(b => b.includes('test.describe') || b.includes("import { test"));
  if (testBlock) return testBlock;
  if (blocks.length > 0) return blocks[blocks.length - 1];
  if (text.includes('import { test, expect }') || text.includes('import {test, expect}')) return text.trim();
  return text.trim();
}

function extractClassName(code: string): string | null {
  const match = code.match(/export\s+class\s+(\w+)/);
  return match ? match[1] : null;
}

export function toTag(title: string): string {
  return '@' + title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 30);
}

function injectTag(code: string, tag: string): string {
  if (code.includes(tag)) return code;
  return code.replace(
    /test\.describe\((['"])([^'"]*)\1/,
    (_, q, title) => `test.describe(${q}${title.trim()} ${tag}${q}`,
  );
}

/**
 * Converts a raw MCP action label (e.g. `browser_fill({"selector":"...","value":"..."})`)
 * into a plain-English step for the requirements MD.
 * Skips read-only inspection calls (browser_query_all, browser_get_form_map, etc.).
 */
function actionToStep(label: string): string | null {
  try {
    const parenIdx = label.indexOf('(');
    if (parenIdx === -1) return null;
    const tool = label.slice(0, parenIdx);
    const args = JSON.parse(label.slice(parenIdx + 1, -1)) as Record<string, string>;

    switch (tool) {
      case 'browser_navigate':
        return `Navigate to ${args.url ?? args.path ?? ''}`;
      case 'browser_fill':
      case 'browser_type': {
        const field = args.label ?? args.name ?? args.selector ?? 'field';
        const val   = args.value ?? args.text ?? '';
        return `Fill "${field}" with "${val}"`;
      }
      case 'browser_click': {
        const tgt = args.label ?? args.text ?? args.selector ?? 'element';
        return `Click "${tgt}"`;
      }
      case 'browser_select_option': {
        const field = args.label ?? args.selector ?? 'dropdown';
        const val   = args.value ?? args.values ?? '';
        return `Select "${val}" in "${field}"`;
      }
      case 'browser_check':
        return `Check "${args.label ?? args.selector ?? 'checkbox'}"`;
      case 'browser_uncheck':
        return `Uncheck "${args.label ?? args.selector ?? 'checkbox'}"`;
      case 'browser_press_key':
        return `Press key "${args.key ?? ''}"`;
      case 'browser_hover':
        return `Hover over "${args.label ?? args.selector ?? 'element'}"`;
      case 'browser_wait_for':
        return `Wait for "${args.text ?? args.selector ?? ''}"`;
      // Skip read-only / query tools — they are not test steps
      case 'browser_query_all':
      case 'browser_query_semantic':
      case 'browser_get_form_map':
      case 'browser_get_url':
      case 'browser_take_screenshot':
      case 'browser_scroll':
        return null;
      default:
        return null;
    }
  } catch {
    return null;
  }
}

/** Saves a generated-requirements MD file in requirements/ for future reference and healing. */
export async function saveGeneratedMd(opts: {
  url: string;
  flowDescription: string;
  outputPath: string;
  pomPath?: string;
  outputDir: string;
  /** Raw MCP action labels from the exploration loop — converted to readable steps. */
  actions?: string[];
  /** Pre-formatted step strings (used by record-to-spec where actions are already parsed). */
  steps?: string[];
}, log: (msg: string) => void): Promise<void> {
  const reqDir  = path.join(process.cwd(), 'requirements');
  const specBase = path.basename(opts.outputPath, '.spec.ts');
  const mdPath   = path.join(reqDir, `${specBase}.md`);

  await fs.mkdir(reqDir, { recursive: true });

  const now = new Date().toISOString();
  const pomLine = opts.pomPath
    ? `pomFile: ${path.relative(process.cwd(), opts.pomPath)}`
    : '';

  // Build the steps section — prefer pre-formatted steps, fall back to converting actions.
  const resolvedSteps: string[] = opts.steps?.length
    ? opts.steps
    : (opts.actions ?? []).map(actionToStep).filter((s): s is string => s !== null);

  const stepsSection = resolvedSteps.length
    ? [
        '## Steps Explored',
        '',
        ...resolvedSteps.map((s, i) => `${i + 1}. ${s}`),
        '',
      ]
    : [];

  const content = [
    '---',
    `baseUrl: ${opts.url}`,
    `outputDir: ${opts.outputDir}`,
    `mode: pom`,
    `generatedAt: ${now}`,
    `specFile: ${path.relative(process.cwd(), opts.outputPath)}`,
    ...(pomLine ? [pomLine] : []),
    '---',
    '',
    `# Generated: ${opts.flowDescription}`,
    '',
    `> Auto-generated by AI flow generator on ${now.slice(0, 10)}`,
    `> Source URL: ${opts.url}`,
    `> Spec: \`${path.relative(process.cwd(), opts.outputPath)}\``,
    ...(opts.pomPath ? [`> POM: \`${path.relative(process.cwd(), opts.pomPath)}\``] : []),
    '',
    '## Flow Description',
    '',
    opts.flowDescription,
    '',
    ...stepsSection,
    '## Notes',
    '',
    '- This file is auto-generated. Edit the original requirements MD and re-run generation to update.',
    '- Used by the healing engine to match failing tests back to their source URL and requirements.',
    '',
  ].join('\n');

  await fs.writeFile(mdPath, content, 'utf-8');
  log(`[Flow Generator] Requirements MD saved: ${path.relative(process.cwd(), mdPath)}`);
}

// Scans existing page objects and the fixture registry so the AI knows what
// is already available and can reuse it instead of generating duplicates.
async function gatherExistingInfra(rootDir: string): Promise<string> {
  const out: string[] = [];

  // ── 1. Parse fixture registry → fixture-name : class-name mapping ──────────
  type FixtureEntry = { fixture: string; className: string; file: string };
  const fixtureMap: FixtureEntry[] = [];

  try {
    const raw = await fs.readFile(path.join(rootDir, 'src/fixtures/pageObjects.ts'), 'utf-8');

    const importRe = /import\s+(?:\{?\s*(\w+)\s*\}?)\s+from\s+'\.\.\/pages\/([^']+)'/g;
    const importedFrom = new Map<string, string>();
    let m: RegExpExecArray | null;
    while ((m = importRe.exec(raw)) !== null) importedFrom.set(m[1], `src/pages/${m[2]}.ts`);

    const block = raw.match(/baseTest\.extend<\{([\s\S]*?)\}>/)?.[1] ?? '';
    const entryRe = /(\w+)\s*:\s*(\w+)\s*;/g;
    while ((m = entryRe.exec(block)) !== null) {
      fixtureMap.push({ fixture: m[1], className: m[2], file: importedFrom.get(m[2]) ?? '' });
    }
  } catch { /* fixture file unreadable — skip */ }

  // ── 2. Scan each page file → class, FULL public method signatures, all selectors ──
  type PageInfo = {
    className:      string;
    file:           string;
    methods:        string[];   // full signatures including return types
    selectorGroups: string;     // rendered selector inventory with values
  };
  const pageInfoList: PageInfo[] = [];

  try {
    const { extractSelectorInventory, renderSelectorInventory } = await import('../utils/pom-patcher');
    const pagesDir = path.join(rootDir, 'src/pages');
    const entries  = (await fs.readdir(pagesDir)).filter(f => f.endsWith('.ts') && f !== 'BasePage.ts');

    const fileResults = await Promise.all(
      entries.map(async (file): Promise<PageInfo | null> => {
        try {
          const content    = await fs.readFile(path.join(pagesDir, file), 'utf-8');
          const classMatch = content.match(/export(?:\s+default)?\s+class\s+(\w+)/);
          if (!classMatch) return null;

          // Extract public method signatures with full return types.
          // Multi-line signatures are joined so the AI sees the complete API surface.
          const methods: string[] = [];
          const lines = content.split('\n');
          for (let i = 0; i < lines.length; i++) {
            const t = lines[i].trim();
            if (!t || t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) continue;
            // Public async/sync methods — exclude private/protected/constructor/get/set
            if (/^(?:async\s+)?(?!private\b|protected\b|constructor\b|get\b|set\b)[a-zA-Z_]\w*\s*\(/.test(t)) {
              // Capture signature up to the opening brace, possibly spanning 2-3 lines
              let sig = t;
              if (!sig.includes('{') && i + 1 < lines.length) sig += ' ' + lines[i + 1].trim();
              sig = sig.replace(/\s*\{[\s\S]*$/, '').trim();
              if (sig.length > 5 && sig.length < 150) methods.push(sig);
            }
          }

          const inv            = extractSelectorInventory(content);
          const selectorGroups = renderSelectorInventory(inv, classMatch[1]);
          return { className: classMatch[1], file, methods, selectorGroups };
        } catch { return null; }
      }),
    );
    for (const info of fileResults) if (info) pageInfoList.push(info);
  } catch { /* no pages dir */ }

  // ── 3. Assemble context string ───────────────────────────────────────────────
  out.push('');
  out.push('╔═══════════════════════════════════════════════════════════════════╗');
  out.push('║   EXISTING FRAMEWORK INFRASTRUCTURE — MANDATORY REUSE RULES      ║');
  out.push('╚═══════════════════════════════════════════════════════════════════╝');
  out.push('');
  out.push('⚠ NON-NEGOTIABLE RULES:');
  out.push('  1. Import ONLY from the fixture file — NEVER from @playwright/test directly');
  out.push('  2. Inject page objects via fixture args — NEVER "new SomeClass(page)"');
  out.push('  3. ► BEFORE writing any selector string, search the SELECTOR LOOKUP TABLE below.');
  out.push('       If the CSS value is already defined → USE THAT PROPERTY, do not re-declare it.');
  out.push('  4. ► BEFORE writing any method, check the METHOD LIST below.');
  out.push('       If a method already does what you need → CALL IT in the spec, do not re-implement.');
  out.push('  5. ALL new methods MUST be added to an EXISTING page file using // ADD TO:');
  out.push('     CREATING A NEW PAGE CLASS FILE IS STRICTLY FORBIDDEN.');
  out.push('     Pick the page file whose class name most closely matches the feature area.');
  out.push('     If the feature has its own dedicated file (e.g. contentPlaylist.page.ts for Content Playlists)');
  out.push('     → use THAT file, even if it is currently empty.');
  out.push('  6. New selectors MUST go into a NEW public selector property object in the ADD TO block,');
  out.push('     NOT as private fields and NOT as commented-out instructions.');
  out.push('');
  out.push('REQUIRED IMPORTS (use these exactly — never @playwright/test):');
  out.push("  import test, { expect } from '../../src/fixtures/pageObjects';");
  out.push("  import ENV from '../../src/utils/env';");
  out.push('');
  out.push('ENVIRONMENT VARIABLES (always use these — NEVER hardcode URLs or credentials):');
  out.push('  ENV.BASE_URL   — TE / theme authoring base URL  (e.g. https://...qa-pathfactory.com)');
  out.push('  ENV.BASE_URL      — default base URL');
  out.push('  (username + password are stored in ENV and read automatically by loginToApplication)');
  out.push('');
  out.push('AUTHENTICATION — use EXACTLY this pattern (one line, no username/password args):');
  out.push('  await loginPage.loginToApplication(ENV.BASE_URL);');
  out.push('  // loginToApplication navigates to ENV.BASE_URL, detects the login form,');
  out.push('  // and fills credentials from ENV.USERNAME / ENV.PASSWORD automatically.');
  out.push('  // Do NOT pass username/password as arguments. Do NOT hardcode any URL.');
  out.push('');

  if (fixtureMap.length > 0) {
    out.push('AVAILABLE PAGE FILES — your new methods MUST go into one of these (pick the best match):');
    out.push('  fixture name               → class              → file');
    out.push('  ──────────────────────────────────────────────────────────────────');
    for (const f of fixtureMap) {
      out.push(`  ${f.fixture.padEnd(28)} → ${f.className.padEnd(32)}→ src/pages/${f.file ?? '?'}`);
    }
    out.push('');

    // Derive URL hints from each page file's visit() body so the selection rule
    // is always accurate even as new fixtures are added — not hardcoded strings.
    out.push('  FIXTURE SELECTION RULE — CRITICAL: you MUST use EXACTLY the fixture name from the');
    out.push('  "fixture name" column above. Do NOT invent fixture names. Pick the correct fixture');
    out.push('  by matching the URL pattern your flow navigates to:');
    const urlHints: Array<[string, string]> = [];
    for (const info of pageInfoList) {
      const fixture = fixtureMap.find(f => f.className === info.className);
      if (!fixture) continue;
      // Try to extract URL hint from visit() or pageUrl property
      const urlM = info.selectorGroups.match(/pageUrl[^:]*:\s*`([^`]+)`/);
      const urlHint = urlM?.[1]?.replace('${ENV.BASE_URL}', '').replace('${ENV.BASE_URL}', '') ?? null;
      if (urlHint) urlHints.push([fixture.fixture, urlHint]);
    }
    for (const [fix, url] of urlHints) {
      out.push(`    ${fix.padEnd(28)} → URL contains: ${url}`);
    }
    out.push('    loginPage                    → authentication steps ONLY (never navigate to a feature page)');
    out.push('    When uncertain: use the fixture whose file already has selectors matching your exploration.');
    out.push('');
    out.push('  ⚠ The fixture variable name in the spec MUST exactly match a name from the left column above.');
    out.push('    If you use a fixture variable that is not in the table, the test will fail to compile.');
    out.push('');
  }

  // Derive the first non-login fixture name for the spec template example
  const exampleFixture = fixtureMap.find(
    f => f.fixture !== 'loginPage' && f.fixture !== 'page' && f.fixture !== 'common',
  )?.fixture ?? 'contentPlaylistPage';

  out.push('CORRECT TEST FILE STRUCTURE (follow this pattern exactly):');
  out.push('  ► Replace FIXTURE_NAME_HERE with the exact fixture name from AVAILABLE PAGE FILES above.');
  out.push('');
  out.push("  import test, { expect } from '../../src/fixtures/pageObjects';");
  out.push("  import ENV from '../../src/utils/env';");
  out.push('');
  out.push("  test.describe('Feature Name', { tag: ['@feature'] }, () => {");
  out.push("    test('should complete the flow', { tag: ['@feature-specific'] },");
  out.push(`      async ({ page, loginPage, FIXTURE_NAME_HERE }) => {  // ← REPLACE FIXTURE_NAME_HERE with exact fixture from table (e.g. ${exampleFixture})`);
  out.push('        test.setTimeout(300_000);');
  out.push('');
  out.push("        await test.step('Authenticate', async () => {");
  out.push('          await loginPage.loginToApplication(ENV.BASE_URL);');
  out.push('          await FIXTURE_NAME_HERE.visit();');
  out.push('        });');
  out.push('');
  out.push("        await test.step('Perform action', async () => {");
  out.push('          // call existing page object methods — see METHOD LIST below');
  out.push('        });');
  out.push('');
  out.push("        await test.step('Verify result', async () => {");
  out.push("          await expect(page.locator('...')).toBeVisible();");
  out.push('        });');
  out.push('      }');
  out.push('    );');
  out.push('  });');
  out.push('');

  if (pageInfoList.length > 0) {
    // ── Section A: METHOD LOOKUP TABLE ─────────────────────────────────────
    out.push('───────────────────────────────────────────────────────────────────');
    out.push('EXISTING METHODS — CHECK BEFORE WRITING NEW ONES');
    out.push('  If a method already handles a step: CALL IT in the spec. Do not re-create it.');
    out.push('───────────────────────────────────────────────────────────────────');
    for (const info of pageInfoList) {
      const fixture = fixtureMap.find(f => f.className === info.className);
      const ref     = fixture ? ` [fixture: "${fixture.fixture}"]` : '';
      out.push('');
      out.push(`  ┌─ ${info.className}${ref}  →  src/pages/${info.file}`);
      if (info.methods.length === 0) {
        out.push('  │  (no public methods)');
      } else {
        // Show ALL methods — the AI must see the complete surface to avoid duplicates
        for (const method of info.methods) out.push(`  │  ${method}`);
      }
      out.push('  └─');
    }
    out.push('');

    // ── Section B: SELECTOR LOOKUP TABLE ───────────────────────────────────
    out.push('───────────────────────────────────────────────────────────────────');
    out.push('SELECTOR LOOKUP TABLE — CROSS-REFERENCE AGAINST WHAT YOU FIND IN THE BROWSER');
    out.push('  When you find a CSS selector during exploration, look it up here first.');
    out.push('  If the value already exists as a property → USE THAT PROPERTY, never re-declare.');
    out.push('───────────────────────────────────────────────────────────────────');
    for (const info of pageInfoList) {
      if (!info.selectorGroups) continue;
      out.push('');
      out.push(`  ┌─ ${info.className}  →  src/pages/${info.file}`);
      for (const line of info.selectorGroups.split('\n')) {
        if (line.trim()) out.push(`  │  ${line}`);
      }
      out.push('  └─');
    }
    out.push('');
  }

  out.push('═══════════════════════════════════════════════════════════════════');
  out.push('HOW TO OUTPUT THE POM BLOCK — READ CAREFULLY');
  out.push('═══════════════════════════════════════════════════════════════════');
  out.push('');
  out.push('CASE A — Adding to an existing class (ALWAYS prefer this):');
  out.push('  • First line MUST be: // ADD TO: src/pages/<existing-file>.ts');
  out.push('  • Output ONLY real executable TypeScript — NO class wrapper, NO imports');
  out.push('  • Write code at COLUMN 0 — the framework indents it automatically');
  out.push('  • If existing selector properties cover your needs, use them (e.g. this.experience.cpThemeName)');
  out.push('  • If you need NEW selectors not in the SELECTOR LOOKUP TABLE:');
  out.push('    → Declare them as a NEW public property object FIRST in the ADD TO block');
  out.push('    → Reference that new object in your methods: this.myNewGroup.mySelector');
  out.push('    → NEVER leave selector values in comments — the framework cannot execute comments');
  out.push('    → NEVER add properties to existing objects (the framework cannot merge into them)');
  out.push('');
  out.push('  Example — patching the Content Playlist page file with new selectors + methods:');
  out.push('  ```typescript');
  out.push('  // ADD TO: src/pages/contentPlaylist.page.ts');
  out.push('');
  out.push('  public contentPlaylistFilters = {');
  out.push("    searchInput: '[data-testid=\"search-input\"]',");
  out.push("    statusFilter: '[data-testid=\"status-filter\"]',");
  out.push('  };');
  out.push('');
  out.push('  // [AI-generated]');
  out.push('  async searchByName(name: string): Promise<void> {');
  out.push('    await this.page.locator(this.contentPlaylistFilters.searchInput).fill(name);');
  out.push('  }');
  out.push('');
  out.push('  // [AI-generated]');
  out.push('  async filterByStatus(status: string): Promise<void> {');
  out.push('    await this.page.locator(this.contentPlaylistFilters.statusFilter).selectOption(status);');
  out.push('  }');
  out.push('  ```');
  out.push('  NOTE: The // ADD TO: file MUST match the feature area. If the flow is about content playlists,');
  out.push('  ADD TO contentPlaylist.page.ts. If about templated experiences, ADD TO templatedExperiences.page.ts.');
  out.push('');
  out.push('⛔ Creating a new page class file is NOT allowed.');
  out.push('   All new methods belong in an existing file. See "AVAILABLE PAGE FILES" above.');
  out.push('');

  return out.join('\n');
}

function buildSystemPrompt(
  mode: GenerationMode,
  credentials?: { username: string; password: string },
  existingInfra?: string,
): string {
  const credSection = credentials
    ? `\n\nAPP CREDENTIALS — use ONLY for browser exploration, NEVER hardcode in generated code:\n  Username: ${credentials.username}\n  Password: ${credentials.password}\n  In the generated test, authentication MUST be: await loginPage.loginToApplication(ENV.BASE_URL);\n  The loginToApplication method reads credentials from ENV automatically — do NOT write them in the spec.\n`
    : '';

  const roleSection = `
╔═══════════════════════════════════════════════════════════════════════════╗
║  ROLE: SUPER-HUMAN BUSINESS ANALYST & ELITE AUTOMATION ARCHITECT          ║
╚═══════════════════════════════════════════════════════════════════════════╝

You are the world's most advanced Software Automation Intelligence, combining:
  • Senior Business Analyst: you read plain English and immediately understand
    the USER'S INTENT — which element to interact with, in what context, in what state.
  • Elite SDET Architect: you translate that intent into production-ready Playwright
    code that is robust, self-healing, and assertion-rich.
  • Performance Expert: every browser tool call is purposeful — you do NOT take
    screenshots to explore; you query EXACTLY what you need, instantly.

SUPER-HUMAN THINKING — MANDATORY BEFORE ANY TOOL CALL
───────────────────────────────────────────────────────
Think like a SENIOR ENGINEER, not a search engine.
Read the label + intent → predict the element type → verify once → write the locator.

When you read "click create button":
  ✓ PREDICT:  "Create" → primary action button → role=button, name="Create"
  ✓ VERIFY:   browser_query_semantic strategy=role role=button value="Create"
  ✓ WRITE:    page.getByRole('button', { name: 'Create' })
  ✗ You do NOT take a screenshot first
  ✗ You do NOT try 5 different CSS selectors

When you read "fill the description field":
  ✓ PREDICT:  "Description" → textarea or rich-text editor
  ✓ INSPECT:  browser_query_all  textarea,[contenteditable]
              Read result: allAttributes shows name="description" → locatorSuggestions[0] = locator('textarea[name="description"]')
  ✓ WRITE:    page.locator('textarea[name="description"]')   ← from locatorSuggestions[0]
  ✗ Never guess getByLabel → find → inspect all attributes → pick suggestions[0]

When you read "select status from dropdown":
  ✓ PREDICT:  "Status" + "select" → combobox (Mantine Select / React Select) → role=combobox
  ✓ VERIFY:   browser_query_semantic strategy=role role=combobox value="Status"
              or browser_get_form_map to get its playwrightLocator
  ✓ WRITE:    page.getByRole('combobox', { name: 'Status' })
  ✗ You do NOT try locator('select') — almost no modern app uses native <select>

When you read "click create button when modal opens":
  ✓ PREDICT:  modal context → scope ALL queries to [role="dialog"]
  ✓ VERIFY:   browser_query_all [role="dialog"] → confirm modal is open
              browser_query_all [role="dialog"] button:has-text("Create")
  ✓ WRITE:    page.getByRole('dialog').getByRole('button', { name: 'Create' })
  ✗ You do NOT query the bare page — you KNOW the element is inside the modal

When you read "enable the active toggle":
  ✓ PREDICT:  "Active" + "enable" → checkbox or switch → role=checkbox or role=switch
  ✓ VERIFY:   browser_query_semantic strategy=role role=checkbox value="Active"
              if count=0: browser_query_semantic strategy=role role=switch value="Active"
  ✓ WRITE:    page.getByRole('switch', { name: 'Active' })
  ✗ You do NOT use locator('.toggle') — class-only selector breaks on every build

SPEED PRINCIPLE: Most flow steps need EXACTLY 2 tool calls:
  1. browser_query_all  <targeted selector>  → verify count=1
  2. browser_click  /  browser_fill  /  browser_select  → execute the action
  If count=1 on the first query → PROCEED — do not waste a turn on a second query.
  Reserve screenshots for genuine layout mysteries (max 1 per UI section).

Your mandate is to produce flawless, production-ready Playwright code that:
  • Understands the business intent from plain English — not just the literal words
  • Picks the RIGHT locator on the FIRST try by thinking like a human who sees the screen
  • Reuses the existing framework to its fullest before writing a single new line
  • Handles modals, wizards, loading states, and state-dependent elements automatically
  • Asserts business outcomes — not just "element is visible"
  • Survives long-term without maintenance

WORKFLOW — FOUR MANDATORY PHASES BEFORE WRITING ANY CODE
──────────────────────────────────────────────────────────

PHASE 1 — DECODE THE BUSINESS INTENT (do this mentally in 5 seconds, no tools)
  Read the entire flow description. For EACH step, extract:
    action:   click | fill | select | navigate | verify | wait | check
    target:   the element name (button label, field label, option text)
    context:  page | modal | dropdown | tab | wizard-step-N | sidebar
    state:    visible | enabled | not-disabled | after-previous-step

  Build a one-sentence model: "As a [user], I [action] [target] [in context] [when state]."
  This model drives every selector decision — you already KNOW what to query before browsing.

PHASE 2 — AUDIT THE EXISTING FRAMEWORK (before opening the browser)
  Check the EXISTING FRAMEWORK INFRASTRUCTURE section:
    ✓ COVERED  → method already exists → CALL IT in the spec, write ZERO new code
    ✗ MISSING  → needs new code → you will write it in Phase 4

PHASE 3 — BROWSE & VERIFY (one targeted query per element, no fishing expeditions)
  Execute each step using the BUSINESS ANALYST FAST-PATH (see EXPLORER PROTOCOL below).
  Gather only what you need — nothing more.

PHASE 4 — WRITE PRODUCTION CODE
  Use only selectors you verified worked in Phase 3.
  Call existing COVERED methods from Phase 2 — never re-implement them.
  The goal is ZERO new code for already-covered steps.

SEMANTIC INTENT DECODER — KNOW THE ELEMENT BEFORE YOU QUERY
─────────────────────────────────────────────────────────────
A senior engineer reads the field label and user intent and INSTANTLY knows the
element type, likely role, and best locator — BEFORE running a single browser query.
You must do the same. Use this table to pre-compute your locator strategy:

  FIELD LABEL / INTENT         → PREDICTED ELEMENT        → FIRST LOCATOR TO TRY
  ──────────────────────────────────────────────────────────────────────────────────
  "Name", "Title", "Username"  → <input type="text">      → getByLabel('Name')
  "Email"                      → <input type="email">     → getByLabel('Email')
  "Phone", "Mobile"            → <input type="tel">       → getByLabel('Phone')
  "Password"                   → <input type="password">  → getByLabel('Password')
  "Search"                     → <input type="search">    → getByRole('searchbox') or getByPlaceholder
  "URL", "Website", "Link"     → <input type="url">       → getByLabel('URL')
  "Price", "Amount", "Count"   → <input type="number">    → getByRole('spinbutton', {name})
  "Description", "Notes",
  "Comments", "Bio", "Message",
  "Details", "Content", "Body" → <textarea> or contenteditable rich-text
                                                          → getByLabel('Description')
                                                             or getByRole('textbox', {name:'Description'})
                                                             or locator('[contenteditable]') if rich-text
  "Date", "Start Date",
  "End Date", "Deadline",
  "Scheduled"                  → <input type="date"> or custom date picker
                                                          → getByLabel('Start Date')
                                                             if custom: locator('[placeholder*="date" i]')
  "Time"                       → <input type="time">      → getByLabel('Time')
  "Status", "Type", "Theme",
  "Category", "Priority",
  "Environment" (single pick)  → <select> or combobox     → getByRole('combobox', {name:'Status'})
  "Tags", "Labels",
  "Skills", "Interests"
  (multi-pick)                 → multi-select combobox    → getByRole('combobox', {name:'Tags'})
                                                             open → getByRole('option', {name:'X'})
  "Active", "Enabled",
  "Published", "Visible",
  "Allow", "Enable X"          → <input type="checkbox">
                                  or toggle/switch        → getByRole('checkbox', {name:'Active'})
                                                             or getByRole('switch', {name:'Active'})
  "Upload", "Choose File",
  "Browse", "Attach"           → <input type="file">      → locator('input[type="file"]')
                                                             (hidden — trigger via setInputFiles)
  "Color", "Colour"            → color picker             → locator('input[type="color"]') or custom
  "Rating", "Stars"            → radio group or custom    → getByRole('radio', {name:'3 stars'})
  "Save", "Submit", "Create",
  "Add", "Update", "Confirm"   → <button> (primary)       → getByRole('button', {name:'Save'})
  "Cancel", "Close", "Dismiss" → <button> or link         → getByRole('button', {name:'Cancel'})
                                                             or getByRole('dialog').getByRole('button', {name:'Cancel'})
  "Edit", "Delete", "Remove"
  (icon button / action)       → button, span, or a       → getByRole('button', {name:'Edit'})
                                                             or locator('[aria-label="Edit"]')
                                                             or getByRole('row',{name:'X'}).getByRole('button',{name:'Edit'})

  WHEN YOUR PREDICTED LOCATOR RETURNS COUNT=0:
  → The element type doesn't match your prediction (e.g. Description is a rich-text div, not textarea)
  → Ask yourself: "What ELSE could a '[field label]' field be in this app?"
  → Description → try [contenteditable], then .ql-editor (Quill), .ProseMirror (TipTap)
  → Date → try input[type="text"] with date format placeholder, then custom calendar trigger
  → Status → try [role="listbox"], [role="menu"], or custom dropdown (not native <select>)
  → Then use browser_get_form_map to let the app tell you exactly what element type it is

  INTENT → LOCATOR DECISION TREE:
  ──────────────────────────────────
  User says "fill [X]"   → predict: input or textarea → getByLabel('[X]') first
  User says "select [X]" → predict: combobox/select   → getByRole('combobox', {name:'[X]'}) first
  User says "check [X]"  → predict: checkbox/switch   → getByRole('checkbox', {name:'[X]'}) first
  User says "click [X]"  → predict: button            → getByRole('button', {name:'[X]'}) first
                                                          if 0: try getByText('[X]', {exact:true})
  User says "upload [X]" → predict: file input        → locator('input[type="file"]') always
  User says "verify [X]" → predict: text/heading      → getByText('[X]') or getByRole('heading', {name:'[X]'})

  KEY PRINCIPLE: You are not a machine that tries strategies until one works.
  You are a senior engineer who REASONS from the label + intent to the right answer,
  VERIFIES it once with browser_query_semantic, then writes it. One predict → one verify → done.`;

  const selectorPriority = `
AUTO-HEALING LOCATOR STRATEGY — PRIORITY ORDER (stop at first UNIQUE match):
══════════════════════════════════════════════════════════════════════════════
  ► VERIFY Tier 1-2 locators using browser_query_semantic before writing them in code.
  ► Use browser_get_form_map to discover form fields' labels and ready-made locators.
  ► The semanticLocator field in browser_query_all results shows the correct locator per element.

CRITICAL — ARIA ROLE vs HTML TAG (read this before every locator decision):
  Playwright's getByRole() matches ARIA roles — NOT HTML tag names.
  The ARIA role of an element depends on its tag AND any role= attribute.

  HTML TAG → ARIA ROLE (what getByRole() sees):
  ┌──────────────────────────────────┬─────────────────────────────────────────────────┐
  │ HTML                             │ ARIA role / correct Playwright locator          │
  ├──────────────────────────────────┼─────────────────────────────────────────────────┤
  │ <input type="text">              │ textbox   → getByRole('textbox', {name:'...'})  │
  │ <textarea>                       │ textbox   → getByRole('textbox', {name:'...'})  │
  │ <div contenteditable="true">     │ textbox   → getByRole('textbox', {name:'...'})  │
  │ <button>                         │ button    → getByRole('button', {name:'...'})   │
  │ <div role="button">              │ button    → getByRole('button', {name:'...'})   │
  │ <span role="button">             │ button    → getByRole('button', {name:'...'})   │
  │ <a href="#">                     │ link      → getByRole('link', {name:'...'})     │
  │ <span> / <div> (NO role attr)    │ ⚠ NO role → getByRole() WILL NOT find it       │
  │ <li role="option">               │ option    → getByRole('option', {name:'...'})   │
  │ <select>                         │ combobox  → getByRole('combobox', {name:'...'}) │
  │ <input type="checkbox">          │ checkbox  → getByRole('checkbox', {name:'...'}) │
  └──────────────────────────────────┴─────────────────────────────────────────────────┘

  ⚠ WHEN getByRole() RETURNS COUNT=0:
    The element is a <span>, <div>, <li>, or custom tag with NO ARIA role attribute.
    DO NOT force a getByRole() — it will never match.
    Use the TAG-AGNOSTIC FALLBACKS below instead.

  TAG-AGNOSTIC FALLBACKS (when role-based query returns 0):
  ─────────────────────────────────────────────────────────
    For a clickable element (button-like span/div/a/li with no role):
      1. page.getByText('Button Label', { exact: true })
           ← matches any tag by visible text — works for <span>, <div>, <a>, <li>
      2. page.locator(':is(button, [role="button"], span, a, li):has-text("Label")')
           ← targeted multi-tag selector — use when text alone is ambiguous
      3. page.locator('span:has-text("Save")') scoped inside a container:
           page.getByRole('toolbar').locator('span:has-text("Bold")')
           page.getByRole('dialog').locator('a:has-text("Confirm")')

    For a text input (custom editor, no role, no label):
      1. page.locator('[contenteditable="true"]')
           ← rich-text editors: Quill, Slate, TipTap, Draft.js
      2. page.locator('textarea, input[type="text"], [contenteditable]').filter({ hasText: '' })
           ← multi-tag safe when only one text field is present
      3. Scope to nearest container heading:
           page.getByRole('group', { name: 'Section' }).locator('[contenteditable]')

    ALWAYS verify with browser_query_all before using any of the above.
    Check the semanticLocator field in results — it suggests the best locator.

  BEFORE PICKING ANY LOCATOR — SCAN ALL ATTRIBUTES OF THE TARGET ELEMENT:
  ─────────────────────────────────────────────────────────────────────────
  A superhuman engineer does not guess — they READ the element's attributes first.
  For every form field, call browser_query_all with the element selector and inspect:
    • name="..."        ← MOST STABLE — backend-tied, never auto-generated, unique in form
    • aria-label="..."  ← explicit ARIA label
    • aria-labelledby   ← points to a label element → read that element's text
    • placeholder="..." ← visible hint text
    • id="..."          ← ONLY if NOT auto-generated (no mantine-/ruid-/react-select-)
    • data-testid="..." ← explicit test hook
    • type="..."        ← input type hint (text/email/password/number/date/file/checkbox)

  REAL EXAMPLE (from app HTML):
    <textarea name="description" class="mantine-Input-input mantine-Textarea-input mantine-5xpzx2"
              id="mantine-r5b2s92nu" aria-invalid="false">
    → name="description"          ✓ USE THIS → page.locator('[name="description"]')
    → id="mantine-r5b2s92nu"      ✗ SKIP — auto-generated Mantine ID
    → class="mantine-Input-input" ✗ SKIP — Mantine class, breaks on rebuild
    → label associated via aria   ✓ ALSO VALID → page.getByLabel('Description')

  Tier 1 — Semantic (most resilient — survives full UI redesigns):
  1. page.getByLabel('Experience Name')
       ← Verify: browser_query_semantic strategy=label value="Experience Name"
       ← Discover: browser_get_form_map → playwrightLocator field
       ← This works when <label for="id"> or wrapping <label> exists

  2. page.locator('[name="description"]')  ←← FOR FORM FIELDS: CHECK THIS FIRST
       ← The name attribute is SET BY DEVELOPERS to match the API/backend field name
       ← It is NEVER auto-generated — it identifies the field's semantic purpose
       ← It is UNIQUE within a form (forms cannot submit two fields with same name)
       ← Verify: browser_query_all  [name="description"]  → should return count=1
       ← Combined with tag for precision: page.locator('textarea[name="description"]')
       ← Combined with scope: page.getByRole('dialog').locator('[name="description"]')

  3. page.getByRole('button', { name: 'Create Experience' })
       ← Verify: browser_query_semantic strategy=role role=button value="Create Experience"
       ← If count=0: element has no button role → use TAG-AGNOSTIC FALLBACKS above

  4. page.getByPlaceholder('Enter name...')
       ← Verify: browser_query_semantic strategy=placeholder value="Enter name..."

  5. page.getByText('Create Experience', { exact: true })
       ← Verify: browser_query_semantic strategy=text value="Create Experience" exact=true

  Tier 2 — Attribute (stable when semantic is unavailable):
  6. page.locator('[data-testid="create-experience-btn"]')
       ← Purpose-built test hook — excellent stability
  7. page.locator('[aria-label="..."]')  /  page.locator('#stable-id')
       ← Stable ARIA attributes or non-generated IDs
  8. page.locator('[type="submit"]') / page.locator('input[type="email"]')
       ← HTML input type — useful when name is not set

  Tier 3 — Structural CSS (use with container scoping):
  8. page.locator('[data-section="wizard"] button.primary')
       ← Always scope to a container — never bare CSS class selectors
       ← NEVER: .btn, .modal, .container, .icon  (match dozens of elements)
       ← NEVER: :nth-child() or positional CSS  (breaks with UI changes)

  Tier 4 — Dynamic XPath (LAST RESORT — only when all tiers above are non-unique):
  9. page.locator('xpath=//button[.//span[normalize-space()="Create Experience"]]')
       ← Use ONLY after verifying all tiers 1-8 match >1 element.
       ← Prefer text-based axes: normalize-space(), contains(), starts-with()
       ← Use ancestor/sibling axes to add context:
           xpath=//div[@role="dialog"]//input[@placeholder="Name"]
       ← Use position only inside a scoped container, NEVER globally:
           xpath=(//div[@data-section="wizard"]//button)[1]
       ← Combine attributes for uniqueness:
           xpath=//input[@type="text" and @id and not(@readonly)]
       ← MANDATORY after writing any XPath: run browser_query_all xpath=... — it MUST return exactly 1 result.
       ← If it returns 0: the XPath is wrong — retry with a different XPath.
       ← If it returns >1: the XPath is not unique — add more context (ancestor/attribute) and retry.
       ← You MUST NOT write the XPath into the POM until browser_query_all confirms count=1.

⚠ LOCATOR UNIQUENESS — MANDATORY RULES:
  • Before using ANY selector in generated code, verify with browser_query_all that it
    matches EXACTLY ONE element. If it matches >1, escalate to the next tier.
  • XPATH RULE: Every XPath selector MUST be verified with browser_query_all before use.
    If the result is not exactly [1 element found], do NOT use it — try a different selector.
    This verification is NOT optional — skipping it is the #1 cause of broken tests.
  • NEVER use class-only selectors: .btn, .modal, .container, .form, .icon
  • NEVER use :nth-child() or index-based CSS — fragile when the UI shifts.
  • NEVER use text that changes between environments (usernames, dates in labels).
  • ALWAYS scope to container when multiple similar elements exist:
      BAD:  page.locator('button[type="submit"]')
      GOOD: page.locator('[data-testid="create-modal"] button[type="submit"]')
      GOOD: page.getByRole('dialog').getByRole('button', { name: 'Create' })
  • Missing data-testid? Note: // TODO: ask dev to add data-testid="..."
    and use the next best unique selector (XPath if necessary) as a fallback.

⛔ FORBIDDEN LOCATOR PATTERNS — NEVER USE THESE IN GENERATED CODE:
══════════════════════════════════════════════════════════════════════
  These selectors BREAK every time the app re-renders or upgrades its UI library.
  If you see one of these during exploration — STOP and find a semantic alternative.

  FORBIDDEN — Mantine UI auto-generated IDs (e.g. #mantine-5sdvkuk6v):
    Mantine generates unique IDs per component instance on EVERY render.
    ← Instead for textareas/inputs: page.getByRole('textbox', { name: 'Field Label' })
                                    page.getByLabel('Field Label')
                                    page.getByPlaceholder('placeholder text')
                                    page.locator('textarea[aria-label*="label" i]')
    ← Instead for checkboxes:      page.getByRole('checkbox', { name: 'Item Name' })
                                    page.locator('label:has-text("Item Name") input[type="checkbox"]')
                                    page.locator('xpath=//label[normalize-space()="Item Name"]//input[@type="checkbox"]')

  FORBIDDEN — Other auto-generated IDs (same rule):
    #ruid-[a-z0-9]+       React UUID auto-generated IDs
    #react-select-[0-9]+  React Select library IDs
    #rc_[a-z0-9]+         rc-* component library IDs
    [id^="mantine-"]      Any attribute selector targeting Mantine dynamic IDs

  AUTO-GENERATED ID DETECTION: Any ID matching "prefix-RANDOMHASH" where RANDOMHASH
  is 6+ alphanumeric chars (letters+digits mixed): "mantine-5sdvkuk6v", "ruid-a3b8c2" → NEVER use.

  MANDATORY VERIFICATION: Before writing any locator, confirm with browser_query_all
  that it returns EXACTLY 1 element. Count=0 or >1 → try again with a different approach.

NEAREST-LABEL FALLBACK — MANDATORY WHEN TIER 1 IS NOT OBVIOUS:
══════════════════════════════════════════════════════════════════
  Before EVER falling to CSS class selectors or structural XPath, do this first:

  STEP 1: Call browser_get_form_map (MANDATORY before any form interaction)
    → It maps every visible field to its label and a ready-made playwrightLocator.
    → Use the playwrightLocator it gives you — no guessing needed.
    → If inside a modal: browser_get_form_map selector='[role="dialog"]'

  STEP 2: If browser_get_form_map doesn't find your field, find the nearest <label>:
    → browser_query_all  label
    → Read innerText of each label result — find the one nearest to your input
    → Use that label text to build the locator:

    FROM NEAREST LABEL (in priority order):
      a) page.getByLabel('Label Text')
           ← Works when <label for="inputId"> or wrapping <label><input></label>
      b) page.getByRole('textbox', { name: 'Label Text' })
           ← Works when ARIA is set via aria-label or aria-labelledby
      c) page.locator('label:has-text("Label Text") input')
           ← When the label wraps the input (implicit association)
      d) page.locator('label:has-text("Label Text") + input')
      e) page.locator('label:has-text("Label Text") ~ input')
           ← When label is a sibling of the input
      f) xpath=//label[normalize-space()="Label Text"]/following-sibling::input[1]
      g) xpath=//label[normalize-space()="Label Text"]/..//input
           ← When label and input share a parent container

  STEP 3: For icon buttons or buttons with no visible text:
    → browser_query_all  button[aria-label],[role="button"][aria-label]
    → Use: page.locator('button[aria-label="Save"]')
    → Or scope to nearest named container:
         page.getByRole('toolbar', { name: 'Formatting' }).getByRole('button', { name: 'Bold' })

  STEP 4: For elements with no label at all — look at their container heading:
    → browser_get_element_context  selector="input[type='text']"
    → It returns nearestHeading and suggestedLocator per element
    → Use suggestedLocator directly — it is already scoped correctly

  EXAMPLES OF IMPROVEMENT:
    BAD (fragile CSS):   page.locator('.mantine-TextInput-input')
    GOOD (label-based):  page.getByLabel('Experience Name')

    BAD (nth-child):     page.locator('form > div:nth-child(3) input')
    GOOD (label-based):  page.locator('label:has-text("Start Date") input')

    BAD (auto-ID):       page.locator('#mantine-r5x8c9v-input')
    GOOD (role+name):    page.getByRole('textbox', { name: 'Theme Name' })

    BAD (class-only):    page.locator('.select-input')
    GOOD (form map):     page.getByLabel('Status') // from browser_get_form_map

  RULE: You MUST exhaust all label-based approaches (Steps 1-4) before writing
  any CSS class selector or positional XPath. Label-based locators survive
  full UI redesigns. CSS class selectors break on the next build.`;

  const codeQualityRules = `
═══════════════════════════════════════════════════════════════════
CODE QUALITY & BEST PRACTICES — NON-NEGOTIABLE
═══════════════════════════════════════════════════════════════════

AUTO-HEALING METHOD STRATEGY:
  • ATOMIC: each method does exactly ONE thing — click, fill, select, verify.
      BAD:  async createExperienceAndVerify()  // too many responsibilities
      GOOD: async clickCreateExperienceButton() / async fillExperienceName() / async verifyEditorOpened()
  • REUSABLE: parameterize inputs — never hardcode values that belong to the test:
      BAD:  async fillName() { await this.page.fill('#name', 'Test Experience'); }
      GOOD: async fillExperienceName(name: string) { await this.page.fill(this.fields.nameInput, name); }
  • DESCRIPTIVE: verb+noun matching the UI action exactly:
      BAD:  clickButton(), fillForm(), doStep1()
      GOOD: clickCreateExperienceButton(), fillExperienceNameField(), selectThemeFromDropdown()
  • FRAMEWORK-CONSISTENT: match the style of existing methods in the same class.
  • Boolean state: is/has prefix → isWizardOpen(), hasErrorBanner()
  • Navigation: visit/navigateTo prefix → visitContentPlaylists()

FLOW HEALING — HANDLE ALL TRANSIENT STATES:
  • Loading spinners: wait for them to disappear before asserting:
      await page.waitForSelector('.loading-spinner', { state: 'hidden', timeout: 10_000 }).catch(() => {});
  • Page transitions: always await networkidle after submit/navigation actions:
      await page.waitForLoadState('domcontentloaded', { timeout: 8_000 }).catch(() => {});
  • Modals/overlays: detect and handle before proceeding:
      if (await page.locator('[role="dialog"]').count() > 0) { ... }
  • Redirect detection: always assert URL pattern after navigation:
      await expect(page).toHaveURL(/expected-path/, { timeout: 15_000 });
  • Element readiness: always assertToBeVisible BEFORE interacting:
      await expect(locator).toBeVisible({ timeout: 10_000 });
      await locator.click();
  • NEVER use page.waitForTimeout() or arbitrary sleep — always use deterministic waits.

MEANINGFUL ASSERTION STRATEGY — VERIFY BUSINESS OUTCOMES:
  • Assert the outcome the USER cares about, not just technical presence:
      WEAK:   await expect(page.locator('button')).toBeVisible();
      STRONG: await expect(page.locator('[data-testid="editor-toolbar"]')).toBeVisible();
              await expect(page).toHaveURL(/\/content-playlists\/\d+\/content-page-settings/);
  • Combine URL + element assertion for navigation steps — proves correct page AND correct state.
  • For form submissions: assert both the redirect (URL) and the success indicator (element).
  • For data creation: assert the item appears in the list with the expected name.
  • One assertion per logical outcome — do NOT chain 10 expects in a single step.
  • Use soft assertions for non-critical checks: expect.soft(locator).toHaveText(...)

SELECTOR CONSTANTS (POM mode):
  • Define EVERY selector as a property at the top of the class.
  • Group by UI section with a comment:
      // ── Creation Wizard ──────────────────────────────────────────────
      public contentPlaylistCreate = {
        createExperienceButton:  'xpath=//button[.//span[normalize-space()="Create Experience"]]',
        submitButton:            '[data-testid="wizard-submit"]',
      };
  • XPath selectors: same string format 'xpath=...' — assign to a property like any other.
  • NEVER write a raw selector string inside a method body — always reference a property.
  • NEVER duplicate a selector that already exists in an existing POM class; reference it instead.

TYPESCRIPT:
  • All POM methods must have an explicit return type: Promise<void>, Promise<string>, etc.
  • Use const, never var. Prefer const over let when value does not change.
  • No implicit any. If a type is unknown use unknown and narrow it.

TEST ISOLATION:
  • Every created item MUST use a unique name with Date.now() or new Date().toISOString()
  • Each test must be independently runnable — no state left by another test.
  • If the test creates data, add cleanup: await featurePage.deleteItem(name);

TEST STRUCTURE:
  • Wrap every logical group in test.step() with a descriptive label.
  • test.setTimeout(300_000) as the first line inside the test body.`;

  const selfHealChecklist = `
═══════════════════════════════════════════════════════════════════
SELF-HEAL REVIEW — MANDATORY CHECKLIST BEFORE FINALIZING OUTPUT
═══════════════════════════════════════════════════════════════════
Before outputting your final code, run through this checklist:

  □ REUSE:     Every step in COVERAGE CHECKLIST marked ✓ COVERED is CALLED, not re-implemented.
  □ SELECTORS: All new selectors start from Tier 1 and escalate — no unjustified XPath use.
  □ SEMANTIC:  For every getByRole/getByLabel/getByPlaceholder in generated code, browser_query_semantic
               was called and returned unique=true. No semantic locator may appear in output without this.
  □ FORM MAP:  For every form in the flow, browser_get_form_map was called and playwrightLocator values
               from its output are used directly in generated code — never hand-crafted CSS for labelled fields.
               Form map output is SECTIONED — use the section heading to distinguish "Name" in "Create Experience"
               from "Name" in "Edit Profile". When a label repeats across sections, use the scoped locator
               the form map provides (e.g. page.getByRole('group',{name:'Create Experience'}).getByLabel('Name')).
  □ DISAMBIG:  When browser_query_semantic returns count > 1 (not unique), you MUST call
               browser_get_element_context with the same selector to get: nearestHeading, containerLabel,
               breadcrumbPath, and suggestedLocator. Then use suggestedLocator (which is already scoped).
               Never write a non-unique locator into generated code — always resolve ambiguity first.
  □ UNIQUENESS: Every selector verified to match exactly 1 element (browser_query_semantic unique=true,
                or browser_query_all count=1). XPath MUST also be verified — no exceptions.
  □ NO CLASS-ONLY: Zero bare .btn / .modal / .container / class-only selectors in generated code.
  □ FLOW HEAL: All navigation/submit actions followed by waitForLoadState or URL assertion.
  □ NO SLEEP:  Zero page.waitForTimeout() calls — only deterministic waits used.
  □ ASSERTIONS: Every test.step() that performs an action has at least one meaningful assertion.
  □ PROPERTIES: Every this.group.prop referenced in a method IS DECLARED in the ADD TO block
                or already exists in the SELECTOR LOOKUP TABLE. No dangling property refs.
  □ ADD TO:    First line of POM block is // ADD TO: src/pages/<existing-file>.ts (no new files).
  □ NO CREDENTIALS: No username or password string appears anywhere in generated code.
  □ ENV ONLY:  All URLs use ENV.BASE_URL or ENV.BASE_URL — zero hardcoded URL strings.
  □ FIXTURES:  Test uses fixture injection async ({ page, loginPage, featurePage }) — no new ClassName(page).

After passing all checks, produce the output in this format:

── OUTPUT FORMAT ──────────────────────────────────────────────────
1. FRAMEWORK ANALYSIS
   • Fixtures used: [list fixture names]
   • Methods reused: [list methods from coverage checklist marked COVERED]
   • New methods needed: [list steps marked MISSING]
   • New selectors needed: [list new selector groups]

2. CHANGES MADE
   • File: src/pages/<file>.ts → added [N] methods, [N] selector groups

3. GENERATED PLAYWRIGHT CODE
   [POM block first, then test spec block]

4. HEALING SUMMARY
   • Locator tier used per element: [e.g. "createBtn: Tier 1 getByRole, submitBtn: Tier 4 XPath"]
   • Flow healing applied: [e.g. "networkidle after submit, spinner wait before assertion"]
   • Assertions chosen: [e.g. "URL pattern + editor toolbar element"]

5. MAINTENANCE NOTES
   • [Any TODO items, e.g. missing data-testid, potential fragility, known limitations]
──────────────────────────────────────────────────────────────────`;

  const explorationProtocol = `
═══════════════════════════════════════════════════════════════════
MANDATORY EXPLORATION PROTOCOL — FOLLOW ALL PHASES IN ORDER
═══════════════════════════════════════════════════════════════════

PHASE 0 — INFRASTRUCTURE AUDIT (do this BEFORE opening the browser)
─────────────────────────────────────────────────────────────────────
Before browsing anything, audit the EXISTING INFRASTRUCTURE shown above.
For each step in the flow:
  a. Check the METHOD LIST — is there already a method that handles this step?
     → If YES: mark it "COVERED" — you will CALL it in the spec, not re-implement.
     → If NO:  mark it "MISSING" — you will need to create it.
  b. Note which fixture provides access to each needed method (e.g. templatedExperiencePage).
  c. Note which selector properties already exist for this feature area.

Create a mental coverage checklist like:
  ✓ COVERED  visitContentPlaylists()        → exists in TemplatedExperiencesPage
  ✓ COVERED  clickOnCreateExperienceButton() → exists in TemplatedExperiencesPage
  ✗ MISSING  selectTemplateFromDropdown()   → needs a new method
  ✗ MISSING  this.createPlaylist.template   → needs a new selector property

Only after this audit may you proceed to browser exploration.
Your coverage checklist determines what NEW code you need to write.

╔═══════════════════════════════════════════════════════════════════════╗
║  BUSINESS ANALYST INTELLIGENCE DECODER — APPLY TO EVERY FLOW STEP   ║
╚═══════════════════════════════════════════════════════════════════════╝

Before executing ANY step, decode the plain-English description in your head:

  EXTRACT: action | target | context | required state
  ─────────────────────────────────────────────────────────────────────
  "click create button"           → action=click, target="Create" button, context=page
  "click create button in modal"  → action=click, target="Create" button, context=[role="dialog"]
  "fill name field"               → action=fill,  target=Name input,       context=current form
  "click create when enabled"     → action=click, target="Create" button, state=not disabled
  "verify success message"        → action=assert,target=success text,    (no click)

HUMAN-INTELLIGENCE FAST-PATH — Semantic first, CSS only as last resort:
─────────────────────────────────────────────────────────────────────────
  ╔══ GOLDEN RULE ══════════════════════════════════════════════════════╗
  ║  Use browser_query_semantic to VERIFY locators — it lets you       ║
  ║  confirm getByRole/getByLabel/getByPlaceholder works BEFORE you    ║
  ║  write it in code. If unique=true → use that locator in the POM.   ║
  ╚═════════════════════════════════════════════════════════════════════╝

  BEFORE INTERACTING WITH ANY FORM — MANDATORY ATTRIBUTE SCAN:
    STEP 1 → Call browser_get_form_map (scoped if inside a modal: selector='[role="dialog"]')
             Output lists every field's: label, name attr, placeholder, type, playwrightLocator
             The playwrightLocator already accounts for name/label/placeholder — use it directly.
    STEP 2 → For each field you will interact with, identify:
             • name="..."       — always present on form submission fields; USE THIS FIRST
             • aria-label="..." — explicit label not tied to a <label> element
             • placeholder="..."— visible hint text
             Read ALL attributes — never assume the obvious locator is the only one.
    STEP 3 → Confirm with browser_query_all [name="fieldname"] → must return count=1
             If count=0: the name attr is not set → use label/placeholder/aria fallback
             If count>1: scope to the form container: [role="dialog"] [name="fieldname"]

    WHY name ATTRIBUTE IS THE BEST FORM FIELD LOCATOR:
    • Set by developers to match the API/database field name — NEVER auto-generated
    • Unique within a form (duplicate names break form submission)
    • Survives UI library upgrades (Mantine v6 → v7), CSS class renames, ID regeneration
    • Directly encodes the field's semantic purpose (name="description" IS the description field)
    EXAMPLE: <textarea name="description" id="mantine-r5b2s92nu" class="mantine-Input-input">
      → USE:  page.locator('[name="description"]')          ✓ stable forever
      → USE:  page.locator('textarea[name="description"]')  ✓ even more precise
      → SKIP: page.locator('#mantine-r5b2s92nu')           ✗ regenerates every render
      → SKIP: page.locator('.mantine-Input-input')         ✗ matches ALL inputs on page

  WHEN A LABEL IS AMBIGUOUS (same label in multiple sections):
    STEP 1 → Call browser_query_semantic  strategy=label  value=[X]
             If count > 1 (not unique): proceed to Step 2
    STEP 2 → Call browser_get_element_context  selector=<css that finds those inputs>
             It returns nearestHeading, containerLabel, breadcrumbPath, sibgestedLocator per match
    STEP 3 → Pick the match whose nearestHeading or containerLabel matches the section you need
             Use its suggestedLocator (already scoped) directly in generated POM code
    EXAMPLE: "Name" appears in 3 sections
      browser_get_element_context  selector="input[type='text']"
      → match[0]: nearestHeading="Create Experience"  → suggestedLocator: page.getByRole('group',{name:'Create Experience'}).getByLabel('Name')
      → match[1]: nearestHeading="Playlist Settings"  → suggestedLocator: page.getByRole('group',{name:'Playlist Settings'}).getByLabel('Name')
      → Use the one for your section. Never guess or use index-based locators.

  "click [X] button"
    → TRY 1: browser_query_semantic  strategy=role  role=button  value=[X]
              If unique=true → use  page.getByRole('button', { name: '[X]' })
              To click now:  browser_click  role=button  name=[X]
    → TRY 2: browser_query_all  button:has-text("[X]")  (check semanticLocator field)
    → TRY 3 (if count=0 — element may be a span/div/a with no role attribute):
              browser_query_all  :is(button,[role="button"],span,a,li):has-text("[X]")
              → If found: use  page.locator(':is(button,[role="button"],span,a,li):has-text("[X]")')
                          or   page.getByText('[X]', { exact: true })  scoped to container
    → TRY 4: browser_query_all  xpath=//button[normalize-space()="[X]"]
              or xpath=//*[normalize-space()="[X]" and contains(@class,"btn")]

  "click [X] button when modal is open" / "in the dialog, click [X]"
    → TRY 1: browser_query_semantic  strategy=role  role=button  value=[X]
    → TRY 2: browser_query_all  [role="dialog"] button:has-text("[X]")
    → TRY 3 (span/div button inside modal, no role):
              browser_query_all  [role="dialog"] :is(button,[role="button"],span,a):has-text("[X]")
              → page.getByRole('dialog').getByText('[X]', { exact: true })
              → page.getByRole('dialog').locator('span:has-text("[X]"), a:has-text("[X]")')
    → NEVER use a bare unscoped query when you know you are inside a modal

  "fill [X] field" / "enter text in [X]"
    → PRE-STEP: Call browser_get_form_map — it shows name/label/placeholder for every field.
                From its output, pick the field matching "[X]" and use its playwrightLocator.
                This is ONE call that resolves the locator without any guessing.

    If browser_get_form_map is unavailable or the field is outside a standard form:

    → TRY 1 — name attribute (MOST STABLE for form fields):
              browser_query_all  [name*="[x]" i]   (lowercase match on the field name slug)
              e.g. for "Description": browser_query_all  [name="description"]
              If count=1 → use  page.locator('[name="description"]')
                           or   page.locator('textarea[name="description"]')  ← more precise
              If scoped to modal: page.getByRole('dialog').locator('[name="description"]')

    → TRY 2 — label association:
              browser_query_semantic  strategy=label  value=[X]
              If unique=true → use  page.getByLabel('[X]')
              To fill now:   browser_fill  label=[X]  value=...
              If count > 1  → DISAMBIGUATE (see WHEN A LABEL IS AMBIGUOUS above)

    → TRY 3 — placeholder:
              browser_query_semantic  strategy=placeholder  value=[X]
              If unique=true → use  page.getByPlaceholder('[X]')

    → TRY 4 — aria-label / combined attribute scan:
              browser_query_all  [aria-label*="[X]" i],[placeholder*="[X]" i]
              Check the semanticLocator field in results — use it directly

    → TRY 5 — contenteditable (rich-text editors — Quill/TipTap/Slate/Draft.js):
              browser_query_all  [contenteditable="true"]
              → page.locator('[contenteditable="true"]')  scoped to container
              → page.getByRole('group', { name: 'Section' }).locator('[contenteditable]')

    NEVER reach TRY 5 without exhausting TRY 1 — the name attribute always exists on
    proper form fields and is FAR more reliable than any CSS class or positional approach.

  "select [X] from dropdown" / "choose [X]"
    → TRY 1: browser_get_form_map → find field by label, use its playwrightLocator
    → TRY 2: browser_query_all  select,[role="combobox"],[role="listbox"]
    → TRY 3: Open dropdown first → browser_query_all [role="option"]:has-text("[X]")

  "verify/assert/check [X] appears":
    → TRY 1: browser_query_semantic  strategy=text  value=[X]
    → TRY 2: browser_query_all  :text("[X]"),[data-testid*="[X]" i]
    → (do NOT click — check count > 0, then write assertion in code)

  ⚠ TOOL OUTPUTS — HOW TO READ THEM AND WHAT TO WRITE IN CODE:

  browser_query_all results contain:
    • allAttributes         — EVERY attribute on the element (name, aria-label, placeholder,
                               data-testid, role, type, id, contenteditable, data-*, etc.)
                               READ THIS FIRST — it shows you everything the element has
    • locatorSuggestions    — RANKED array of ALL possible Playwright locators
                               [0] = most stable → USE THIS in generated code
                               [1], [2] = fallbacks if [0] is ambiguous
    • semanticLocator       — same as locatorSuggestions[0], for quick access
    • name, testid,
      ariaLabel, placeholder — key attributes at top level for quick scanning

  INSPECT-FIRST PARADIGM — replace the TRY 1/2/3 guessing approach:
    OLD WAY (bad): try getByLabel → fails → try placeholder → fails → try nth-child
    NEW WAY (good): call browser_query_all → read allAttributes → pick locatorSuggestions[0]

    Step 1: browser_query_all  input,textarea,[contenteditable]
            → Read each result's allAttributes object
            → Look for: name, data-testid, aria-label, placeholder, id (non-auto)
    Step 2: Check locatorSuggestions[0] in the result
            → It is already ranked: testid > name-attr > getByLabel > getByRole > placeholder
    Step 3: Write locatorSuggestions[0] directly into the POM — done.

  REAL EXAMPLE — Description textarea (Mantine app):
    browser_query_all returns:
      { tag: "textarea",
        allAttributes: { name: "description", required: "", "aria-invalid": "false" },
        name: "description",
        accessibleLabel: "Description",
        locatorSuggestions: [
          "page.locator('textarea[name=\"description\"]')",   ← [0] USE THIS
          "page.locator('[name=\"description\"]')",
          "page.getByLabel('Description')",
          "page.getByRole('textbox', { name: 'Description' })"
        ],
        semanticLocator: "page.locator('textarea[name=\"description\"]')"
      }
    → Write: page.locator('textarea[name="description"]')  ← correct, stable forever

  browser_query_semantic → playwrightLocator field = verify result (unique=true → safe to use)
  browser_get_form_map   → playwrightLocator field per field = already uses this priority

ELEMENT STATE — ENABLED / VISIBLE FILTERING:
─────────────────────────────────────────────
  "click [X] when it is enabled" or "click [X] after form is valid":
    → Check with: browser_query_all  button:not([disabled]):has-text("[X]")
    → If count=0: the button is still disabled — execute prerequisite steps first
    → NEVER click a [disabled] button — it will fail the test silently

  "click [X] when visible" or "click [X] after modal opens":
    → Use browser_wait_for_selector with the modal selector first
    → Then query INSIDE the modal with [role="dialog"] scope

CONTEXT STACK — ALWAYS KNOW WHERE YOU ARE:
────────────────────────────────────────────
  Maintain a mental "context stack" that tracks your current UI scope:
    [PAGE]                → the base page (after navigation)
    [PAGE > MODAL]        → after any [role="dialog"] opens
    [PAGE > MODAL > FORM] → inside a form inside a modal
    [PAGE > DROPDOWN]     → after clicking a dropdown trigger

  RULE 1: All browser_query_all calls MUST use the INNERMOST context as a scope prefix.
  RULE 2: When a modal opens → immediately push [MODAL] onto the stack.
  RULE 3: When a modal closes (its count drops to 0) → pop it from the stack.
  RULE 4: Wizard/multi-step flows → track the current step number.

  HOW TO DETECT MODAL OPEN:
    After every click that might open a modal, run:
      browser_query_all  [role="dialog"]
    If count > 0: you are now inside [PAGE > MODAL]. Scope ALL subsequent queries.
    If count = 0: no modal — continue at [PAGE] scope.

SCREENSHOT POLICY — STRICT:
─────────────────────────────
  NEVER take a screenshot to identify elements. Use these instead:
    • browser_query_all  — finds elements by selector, shows text/attributes
    • browser_get_content — reads the full page structure and text
    • browser_get_url    — confirms URL/state changes

  Screenshots are ONLY allowed:
    ✓ When all 3 query attempts returned 0 results AND you cannot identify the element
    ✓ To confirm a complex layout (e.g. drag-and-drop grid) that queries can't describe
    ✓ MAXIMUM: 1 screenshot per major UI section (not per step)

  A screenshot after every click = 20,000+ wasted tokens per image = PROHIBITED.

PHASE 1 — NAVIGATE & AUTHENTICATE
──────────────────────────────────
Step 1: browser_navigate → go to the target URL
Step 2: browser_get_url → confirm current URL and title (fast — no screenshot needed)
Step 3: If you see a login form (URL contains /sign-in or /login):
  - Fill in credentials with browser_fill
  - Click the login/submit button with browser_click
  - Call browser_wait_for_url until you're past login
  - browser_get_url to confirm authenticated page (no screenshot yet)
Step 4: If a cookie/consent banner appears, dismiss it first.

PHASE 2 — TARGETED PAGE SURVEY (semantic-first)
─────────────────────────────────────────────────
Step 1: browser_get_content — read page structure, headings, and interactive element labels.
         This tells you the page layout WITHOUT a screenshot.
Step 2: For any form in the flow → call browser_get_form_map immediately.
         This replaces individual field queries with one human-readable map.
         Add scope: selector='[role="dialog"]' when inside a modal.
Step 3: For each MISSING step in your coverage checklist, verify the locator:
         → "click [X] button"   → browser_query_semantic  strategy=role  role=button  value=[X]
         → "fill [X] field"     → browser_query_semantic  strategy=label  value=[X]
         → "select [X]"         → browser_get_form_map (field already has playwrightLocator)
         Use browser_query_all ONLY if browser_query_semantic returns count=0.
Step 4: Cross-reference found locators against the SELECTOR LOOKUP TABLE above.
         If the selector already has a named property → USE that property.
(Take ONE browser_screenshot ONLY if browser_get_content AND browser_get_form_map both return nothing useful.)

PHASE 3 — EXECUTE EVERY STEP (BUSINESS ANALYST FAST-PATH)
───────────────────────────────────────────────────────────
⚠ CRITICAL RULE: Complete EVERY SINGLE STEP in the flow description — no skipping.
⚠ CRITICAL RULE: Apply the BUSINESS ANALYST INTELLIGENCE DECODER before each step.
⚠ CRITICAL RULE: Update your CONTEXT STACK after every action.
⚠ CRITICAL RULE: DO NOT write any code until all steps are executed.

For EACH step in the flow — follow this sequence:

  [DECODE] → Read the plain-English step, extract (action, target, context, state).

  [QUERY]  → Run the FAST-PATH query for the decoded action:
             Call 1: targeted query (e.g. button:has-text("Create"))
               count=1 → PROCEED immediately ← THIS IS THE NORMAL FAST PATH
               count=0 → try Call 2 (alternative query)
               count>1 → add context scope prefix and retry
             Call 2 (fallback): scoped or alternative query
             Call 3 (last resort): XPath verified with browser_query_all
             ← NEVER run more than 3 queries per element — it wastes turns

  [STATE]  → For buttons: verify button:not([disabled]) before clicking.
             For modals:  verify [role="dialog"] count>0 before scoped queries.

  [ACT]    → browser_click / browser_fill / browser_select / browser_scroll

  [VERIFY] → After action: browser_get_url (for navigation) OR
             browser_query_all  [role="dialog"] (did a modal open?)
             → NO screenshot unless the above two fail to confirm state.

  [CONTEXT] → Update context stack:
              modal opened?  → push [MODAL] — scope all next queries to [role="dialog"]
              modal closed?  → pop [MODAL]  — return to [PAGE] scope
              navigated?     → reset stack to [PAGE]

MODAL EXECUTION PROTOCOL (when any step happens inside a modal):
  1. Detect: browser_query_all [role="dialog"] — confirm count > 0
     If count=0: the modal hasn't opened yet — execute the trigger step first
  2. Scope: ALL queries become → [role="dialog"] <your-selector>
  3. Sequence inside modal:
     - Query fields/buttons scoped to [role="dialog"]
     - Fill/click inside the modal
     - For multi-step modals: detect step transitions with browser_get_content
  4. Close: Click the submit/confirm/cancel button scoped to [role="dialog"]
  5. Pop: browser_query_all [role="dialog"] count=0 → pop modal from stack

RECOVERY — If a step fails after 3 attempts:
  - Alternative selector tier (e.g. getByRole instead of has-text)
  - Scroll first with browser_scroll, then retry
  - browser_wait_for_selector to wait for dynamic element
  - browser_get_content to re-read the current DOM
  - If still failing: take ONE screenshot to visually diagnose

PHASE 4 — WRITE PRODUCTION CODE
─────────────────────────────────
Only after fully completing all steps above.
Base your code strictly on your Phase 0 coverage checklist:
  • COVERED steps → call the existing method, do NOT re-implement
  • MISSING steps → write new methods/selectors using ONLY selectors you verified in Phase 3
Every selector you write MUST be one you verified worked during exploration.
Every step in the test MUST match what you actually did.`;

  const infraSection = existingInfra ?? '';

  if (mode === 'pom') {
    return `${roleSection}
${credSection}
${infraSection}
${explorationProtocol}

${selectorPriority}
${codeQualityRules}
${selfHealChecklist}

═══════════════════════════════════════════════════════════════════
CODE OUTPUT — PRODUCE EXACTLY TWO TYPESCRIPT BLOCKS
═══════════════════════════════════════════════════════════════════

BLOCK 1 — ADDITIONS TO AN EXISTING PAGE FILE (MANDATORY — never create a new file)
────────────────────────────────────────────────────────────────────────────────────
Look at "AVAILABLE PAGE FILES" in the infrastructure section above.
Select the file whose name/purpose best matches the feature you are automating.
Emit ONLY the new methods and selector groups to add.

⚠ CREATING A NEW CLASS FILE IS STRICTLY FORBIDDEN.
  Every project feature already has a dedicated page file. Use // ADD TO: for all POM output.

⚠ URL RULE: NEVER hardcode a URL string you saw in the browser.
  The host comes from process.env.BASE_URL at runtime. In a POM visit() method write:
    await this.page.goto(\`\${process.env.BASE_URL}/authoring/content-playlists\`, { waitUntil: 'domcontentloaded' });
  In the spec use ENV.BASE_URL:
    loginPage.loginToApplication(ENV.BASE_URL)   ← only the base URL — no path needed for login

⚠ EVERY method you add to an existing class MUST have a // [AI-generated] comment on the line above it.
⚠ NEVER write selector values or instructions as code comments — the framework cannot execute comments.
   Putting "// add createExperienceButton: '...'" in a comment does NOTHING. Write actual TypeScript.
⚠ If your methods reference this.groupName.propName — that property MUST be declared in the ADD TO block
   or ALREADY EXIST in the SELECTOR LOOKUP TABLE above. Referencing a non-existent property causes a
   silent runtime crash that is very hard to debug.

BLOCK 2 — TEST SPEC (use fixture injection — NEVER instantiate page objects with new)
────────────────────────────────────────────────────────────────────────────────────────
\`\`\`typescript
import test, { expect } from '../../src/fixtures/pageObjects';
import ENV from '../../src/utils/env';

test.describe('Feature Name', { tag: ['@feature'] }, () => {
  // Matches the 1920×1080 viewport used during AI exploration.
  test.use({ viewport: { width: 1920, height: 1080 } });

  test('should complete the full flow end-to-end', { tag: ['@feature-specific'] },
    async ({ page, loginPage, featurePage }) => {
      test.setTimeout(300_000);

      await test.step('Authenticate', async () => {
        // loginToApplication navigates to ENV.BASE_URL and logs in using ENV.USERNAME / ENV.PASSWORD
        await loginPage.loginToApplication(ENV.BASE_URL);
        // navigate to the specific feature page after login
        await featurePage.visit();
        await expect(page).toHaveURL(/expected-path/, { timeout: 15_000 });
      });

      await test.step('Perform every step of the flow', async () => {
        // Always assert visibility before interacting
        await expect(page.getByRole('button', { name: 'Create Experience' })).toBeVisible({ timeout: 10_000 });
        await featurePage.openCreateWizard();
        await expect(page.getByRole('dialog')).toBeVisible({ timeout: 10_000 });
      });

      await test.step('Submit and verify', async () => {
        await featurePage.submitForm();
        // Wait for network to settle after submit, then assert the new URL
        await page.waitForLoadState('domcontentloaded', { timeout: 8_000 }).catch(() => {});
        await expect(page).toHaveURL(/expected-path/, { timeout: 15_000 });
        // Assert the business outcome — not just any element, the specific success indicator
        await expect(page.locator('[data-testid="success-element"]')).toBeVisible({ timeout: 10_000 });
        await page.screenshot({ path: 'test-results/final-state.png', fullPage: true });
      });
    }
  );
});
\`\`\`

TEST RULES:
- test.use({ viewport: { width: 1920, height: 1080 } }) — ALWAYS the first line inside test.describe
- test.setTimeout(300_000) — always inside the test body
- Import from '../../src/fixtures/pageObjects' — NEVER from @playwright/test
- NEVER hardcode a URL — always use ENV.BASE_URL (or ENV.BASE_URL)
- Credentials are handled automatically by loginToApplication — NEVER pass username/password manually
- Use fixture injection — NEVER new SomeClass(page)
- Wrap logical groups in test.step() with descriptive labels
- BEFORE every click/fill: await expect(locator).toBeVisible({ timeout: 10_000 })
- AFTER every form submit or action that causes navigation: await page.waitForLoadState('domcontentloaded', { timeout: 8_000 }).catch(() => {})
- NEVER use waitForLoadState('networkidle') — SPAs never reach networkidle; domcontentloaded is correct
- AFTER every navigation step: await expect(page).toHaveURL(/pattern/, { timeout: 15_000 })
- End every test with a page.screenshot({ path: 'test-results/final-state.png', fullPage: true })
- EVERY step from the flow must appear in the test
- Use unique names for any created items: include Date.now() or new Date().toISOString() to avoid collisions
- Every selector used MUST be verified as unique (matches exactly 1 element) during exploration
- NEVER use class-only selectors (.btn, .modal) in the generated spec — prefer getByRole, getByLabel, data-testid`;
  }

  // test mode (no separate POM file — inline selectors + existing fixtures)
  return `${roleSection}
${credSection}
${infraSection}
${explorationProtocol}

${selectorPriority}
${codeQualityRules}
${selfHealChecklist}

═══════════════════════════════════════════════════════════════════
CODE OUTPUT — ONE TYPESCRIPT BLOCK
═══════════════════════════════════════════════════════════════════

\`\`\`typescript
import test, { expect } from '../../src/fixtures/pageObjects';
import ENV from '../../src/utils/env';

test.describe('Feature Name', { tag: ['@feature'] }, () => {
  test.use({ viewport: { width: 1920, height: 1080 } });

  test('should complete the full flow end-to-end', { tag: ['@feature-specific'] },
    async ({ page, loginPage, relevantPage }) => {
      test.setTimeout(300_000);

      await test.step('Authenticate', async () => {
        await loginPage.loginToApplication(ENV.BASE_URL);
        await relevantPage.visit();
        await expect(page).toHaveURL(/expected-path/, { timeout: 15_000 });
      });

      await test.step('Perform main flow', async () => {
        // Use semantic locators first — getByRole, getByLabel, getByText
        await expect(page.getByRole('button', { name: 'Create' })).toBeVisible({ timeout: 10_000 });
        await page.getByRole('button', { name: 'Create' }).click();
        await expect(page.getByRole('dialog')).toBeVisible({ timeout: 10_000 });
      });

      await test.step('Verify result — assert business outcome', async () => {
        // Wait for network to settle after the action
        await page.waitForLoadState('domcontentloaded', { timeout: 8_000 }).catch(() => {});
        // Assert URL proves navigation to the correct page
        await expect(page).toHaveURL(/expected-path/, { timeout: 15_000 });
        // Assert the specific business outcome element that confirms success
        await expect(page.locator('[data-testid="success"]')).toBeVisible({ timeout: 10_000 });
        await page.screenshot({ path: 'test-results/final-state.png', fullPage: true });
      });
    }
  );
});
\`\`\`

TEST RULES:
- test.use({ viewport: { width: 1920, height: 1080 } }) — ALWAYS the first line inside test.describe
- test.setTimeout(300_000) — always inside the test body
- Import from '../../src/fixtures/pageObjects' — NEVER from @playwright/test
- NEVER hardcode a URL — always use ENV.BASE_URL (or ENV.BASE_URL)
- Credentials are handled automatically by loginToApplication — NEVER pass username/password manually
- Use fixture injection — NEVER new SomeClass(page)
- Wrap logical groups in test.step() with descriptive labels
- PREFER semantic locators: page.getByRole(), page.getByLabel(), page.getByText() BEFORE data-testid or CSS
- BEFORE every click/fill: await expect(locator).toBeVisible({ timeout: 10_000 })
- AFTER form submit / navigation-triggering action: await page.waitForLoadState('domcontentloaded', { timeout: 8_000 }).catch(() => {})
- AFTER navigation: await expect(page).toHaveURL(/pattern/, { timeout: 15_000 })
- End the test with a page.screenshot({ path: 'test-results/final-state.png', fullPage: true })
- Use unique names for any created items: include Date.now() or new Date().toISOString() to avoid collisions
- Every selector used MUST be verified as unique (matches exactly 1 element) during exploration
- NEVER use class-only selectors (.btn, .modal) in the spec — use getByRole, getByLabel, or data-testid
- NEVER use waitForLoadState('networkidle') in generated specs — SPAs never reach networkidle; use domcontentloaded`;
}

type McpContentBlock = { type: string; text?: string; data?: string; mimeType?: string };

// Use streaming for all Anthropic calls — avoids the 10-minute timeout on long generations.
async function streamMessage(
  anthropic: Anthropic,
  params: Anthropic.MessageCreateParamsNonStreaming,
): Promise<Anthropic.Message> {
  return anthropic.messages.stream(params as Parameters<typeof anthropic.messages.stream>[0]).finalMessage();
}

// ── Optimisation helpers ───────────────────────────────────────────────────────

/**
 * Strip base64 screenshot images from old tool-result messages.
 * Keeps only the last `keepLast` screenshot-bearing user messages,
 * replacing older ones with their text-only content.
 * This is the biggest single token saving: each JPEG screenshot costs
 * ~20,000–25,000 tokens in the context; a 40-turn run can accumulate 800K+
 * tokens in images alone.
 */
function pruneOldImages(messages: Anthropic.MessageParam[], keepLast = 3): void {
  // Collect indices of user messages that contain embedded screenshots
  const screenshotMsgIndices: number[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role !== 'user' || !Array.isArray(msg.content)) continue;

    const hasImage = (msg.content as any[]).some(
      (block: any) =>
        block.type === 'tool_result' &&
        Array.isArray(block.content) &&
        (block.content as any[]).some((c: any) => c.type === 'image'),
    );
    if (hasImage) screenshotMsgIndices.push(i);
  }

  // Strip images from all but the most-recent `keepLast` screenshot messages
  const toStrip = screenshotMsgIndices.slice(0, Math.max(0, screenshotMsgIndices.length - keepLast));
  for (const idx of toStrip) {
    const msg = messages[idx];
    if (!Array.isArray(msg.content)) continue;
    messages[idx] = {
      ...msg,
      content: (msg.content as any[]).map((block: any) => {
        if (block.type !== 'tool_result' || !Array.isArray(block.content)) return block;
        const stripped = (block.content as any[]).filter((c: any) => c.type !== 'image');
        return { ...block, content: stripped };
      }),
    };
  }
}

/**
 * Adaptive token ceiling per turn.
 * - Most intermediate turns just need to emit a tool call (small).
 * - Code generation turns need a large window for the full TypeScript output.
 * - First turn needs medium space for initial analysis.
 */
function adaptiveMaxTokens(turn: number, maxTurns: number): number {
  if (turn >= Math.floor(maxTurns * 0.8)) return 16384; // code generation turns
  if (turn === 1) return 8192;                           // initial analysis
  return 3072;                                            // typical tool-call turns
}

/**
 * Estimate a sensible turn budget from the flow description.
 * Simple flows don't need 40 turns; reduce to avoid billable wait time.
 */
function estimateMaxTurns(description: string, cap: number): number {
  const words   = description.split(/\s+/).length;
  const actions = (description.match(
    /\b(click|fill|enter|select|navigate|verify|check|assert|login|create|add|delete|open|close|submit|search|upload|download|drag|scroll)\b/gi,
  ) ?? []).length;
  const steps = (description.match(/step\s*\d+|^\d+\.|then\b|after\b|next\b/gim) ?? []).length;

  const complexity = words + (actions * 2) + (steps * 3);
  if (complexity < 50)  return Math.min(15, cap); // simple:  ≤3 actions
  if (complexity < 130) return Math.min(22, cap); // medium:  4-8 actions
  return cap;                                       // complex: 9+ actions
}

// ──────────────────────────────────────────────────────────────────────────────

async function runAgentLoop(
  anthropic:      Anthropic,
  mcpClient:      Client,
  anthropicTools: Anthropic.Tool[],
  systemPrompt:   string,
  userPrompt:     string,
  model:          string,
  maxTurns:       number,
  log:            (msg: string) => void,
): Promise<{ text: string; actions: string[]; turns: number }> {
  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: userPrompt }];
  const actions: string[] = [];
  let turns = 0;
  let outputText = '';

  // Checkpoint at 60% of turns — nudge toward completing the flow
  const nudgeTurn = Math.floor(maxTurns * 0.6);
  // Final code request starts at 90% of turns
  const finalTurn = Math.floor(maxTurns * 0.9);

  while (turns < maxTurns) {
    turns++;
    log(`[Flow Generator] Turn ${turns}/${maxTurns}...`);

    if (turns === nudgeTurn && !outputText) {
      messages.push({
        role: 'user',
        content: `You are ${nudgeTurn} turns in. If you have not yet completed all steps in the flow, focus on finishing them now. Do NOT start writing code until ALL steps are done. Continue executing the remaining steps.`,
      });
    }

    if (turns === finalTurn && !outputText) {
      messages.push({
        role: 'user',
        content: `You are approaching the turn limit. If you have completed all exploration steps, write the final TypeScript code blocks now. If you still have incomplete steps, summarize what you found and write the best code you can with the selectors you have verified.`,
      });
    }

    const params: Anthropic.MessageCreateParamsNonStreaming = {
      model,
      max_tokens: adaptiveMaxTokens(turns, maxTurns),
      system:     systemPrompt,
      tools:      anthropicTools,
      messages,
    };
    // Enable thinking only on turn 1 (planning) and the last 2 turns (code generation).
    // Skipping thinking on intermediate turns saves ~8,000 tokens + 3-5s per turn.
    const useThinking = (turns === 1 || turns >= maxTurns - 1) && supportsThinking(model);
    if (useThinking) {
      (params as unknown as Record<string, unknown>).thinking = { type: 'enabled', budget_tokens: 8000 };
    }

    const t0 = Date.now();
    const response = await streamMessage(anthropic, params);
    if (response.usage) {
      trackTokens('generate', response.usage.input_tokens, response.usage.output_tokens, Date.now() - t0);
    }

    messages.push({ role: 'assistant', content: response.content });
    // Prune old screenshots immediately after adding the assistant response so
    // the NEXT turn's input doesn't carry stale base64 image data.
    pruneOldImages(messages, 3);

    if (response.stop_reason === 'end_turn') {
      for (const block of response.content) {
        if (block.type === 'text') outputText += block.text;
      }
      log('[Flow Generator] Claude finished generating output.');
      break;
    }

    if (response.stop_reason !== 'tool_use') {
      for (const block of response.content) {
        if (block.type === 'text') outputText += block.text;
      }
      break;
    }

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const block of response.content) {
      if (block.type !== 'tool_use') continue;
      const actionLabel = `${block.name}(${JSON.stringify(block.input).slice(0, 100)})`;
      actions.push(actionLabel);
      log(`  → ${actionLabel}`);
      try {
        const mcpResult  = await mcpClient.callTool({ name: block.name, arguments: block.input as Record<string, unknown> });
        const mcpContent = (mcpResult.content ?? []) as McpContentBlock[];
        const resultContent: Array<Anthropic.TextBlockParam | Anthropic.ImageBlockParam> = [];
        for (const c of mcpContent) {
          if (c.type === 'text' && c.text != null) {
            resultContent.push({ type: 'text', text: c.text });
          } else if (c.type === 'image' && c.data != null) {
            resultContent.push({ type: 'image', source: { type: 'base64', media_type: (c.mimeType || 'image/jpeg') as 'image/jpeg' | 'image/png', data: c.data } });
          }
        }
        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: resultContent, is_error: mcpResult.isError === true });
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        log(`  [error] ${block.name}: ${errMsg}`);
        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: [{ type: 'text', text: `Tool error: ${errMsg}` }], is_error: true });
      }
    }
    if (toolResults.length > 0) {
      messages.push({ role: 'user', content: toolResults });
      // Prune again after tool results arrive — screenshots from this tool call
      // are now in history; old ones should be stripped before the next turn.
      pruneOldImages(messages, 3);
    }

    // Collect any text blocks alongside tool use (thinking summaries, etc.)
    for (const block of response.content) {
      if (block.type === 'text') outputText += block.text;
    }

    // Early exit: if code blocks already appeared after 60% of turns,
    // the agent has what it needs — no point continuing browser actions.
    if (turns > Math.floor(maxTurns * 0.6) && hasCodeBlocks(outputText)) {
      log('[Flow Generator] Code blocks detected — stopping agent loop early.');
      break;
    }
  }

  // If we hit maxTurns without code output, force a final generation pass
  if (!hasCodeBlocks(outputText)) {
    log(`[Flow Generator] No code blocks found yet — requesting final output (extra turn)...`);
    messages.push({
      role: 'user',
      content:
        'You must now output the final TypeScript code blocks. ' +
        'Write the complete POM class (Block 1) and test spec (Block 2) using the selectors and steps you discovered. ' +
        'Output ONLY the two typescript code blocks — no extra explanation.',
    });
    const finalParams: Anthropic.MessageCreateParamsNonStreaming = {
      model,
      max_tokens: 16384,
      system:     systemPrompt,
      tools:      [],
      messages,
    };
    const t0 = Date.now();
    const finalResponse = await streamMessage(anthropic, finalParams);
    if (finalResponse.usage) {
      trackTokens('generate', finalResponse.usage.input_tokens, finalResponse.usage.output_tokens, Date.now() - t0);
    }
    for (const block of finalResponse.content) {
      if (block.type === 'text') outputText += block.text;
    }
  }

  return { text: outputText, actions, turns };
}

function hasCodeBlocks(text: string): boolean {
  return /```(?:typescript|ts)\n/.test(text);
}

async function retryExtractPomBlocks(
  outputText: string,
  anthropic:  Anthropic,
  model:      string,
  systemPrompt: string,
  messages:   Anthropic.MessageParam[],
  log:        (msg: string) => void,
): Promise<{ pomCode: string | null; testCode: string }> {
  const extracted = extractPomBlocks(outputText);
  if (extracted) return extracted;

  // Retry: ask Claude to re-emit the code blocks
  log('[Flow Generator] Code extraction failed — retrying with explicit request...');
  const retryMessages: Anthropic.MessageParam[] = [
    ...messages,
    {
      role: 'user',
      content:
        'Your previous response did not contain the required TypeScript code blocks. ' +
        'Please output them now:\n' +
        '1. (Required) The test spec block (with test.describe and fixture injection)\n' +
        '2. (Required if adding new methods) Either a new page class or an ADD TO block:\n' +
        '   // ADD TO: src/pages/<existing-file>.ts\n' +
        '   async methodName(): Promise<void> { ... }\n' +
        'Do not add any explanation — just the ```typescript blocks.',
    },
  ];
  const t0 = Date.now();
  const retryResponse = await streamMessage(anthropic, {
    model,
    max_tokens: 16384,
    system: systemPrompt,
    tools: [],
    messages: retryMessages,
  });
  if (retryResponse.usage) {
    trackTokens('generate-retry', retryResponse.usage.input_tokens, retryResponse.usage.output_tokens, Date.now() - t0);
  }
  let retryText = '';
  for (const block of retryResponse.content) {
    if (block.type === 'text') retryText += block.text;
  }
  const retryExtracted = extractPomBlocks(retryText);
  if (retryExtracted) return retryExtracted;

  throw new Error(
    'Claude did not produce usable TypeScript code blocks after two attempts. ' +
    'Try increasing maxTurns or providing a more specific flow description.',
  );
}

/**
 * Post-generation repair: targeted (non-browser) Claude call that generates
 * method bodies for any missing methods found by TypeScript compilation.
 *
/**
 * Find the most relevant existing page file to patch when the AI either forgot
 * the // ADD TO: directive or specified a non-existent target.
 *
 * Scoring:
 *   +3 if the file's class name or basename appears as a keyword in the flow description
 *   +2 if any word from the flow description appears in the file's public method names
 *   +1 if the POM code references a class property that exists in this file
 *   Tie-break: prefer files with more existing methods (most relevant class)
 */
async function findBestMatchPageFile(
  rootDir:         string,
  pomDir:          string,
  pomCode:         string,
  flowDescription: string,
  log:             (msg: string) => void,
): Promise<string | null> {
  try {
    const pagesDir = path.join(rootDir, 'src/pages');
    const entries  = (await fs.readdir(pagesDir)).filter(f => f.endsWith('.ts') && f !== 'BasePage.ts');
    const descLower = flowDescription.toLowerCase();
    const descWords = descLower.split(/\W+/).filter(w => w.length > 3);

    let bestScore = -1;
    let bestPath: string | null = null;

    for (const file of entries) {
      const absPath = path.join(pagesDir, file);
      const content = await fs.readFile(absPath, 'utf-8').catch(() => '');
      if (!content) continue;

      const basename  = file.replace(/\.ts$/, '').toLowerCase().replace(/[._-]/g, ' ');
      const classMatch = content.match(/export(?:\s+default)?\s+class\s+(\w+)/);
      const className  = classMatch?.[1]?.toLowerCase() ?? '';

      let score = 0;

      // File name / class name in description
      if (descLower.includes(basename.replace(/ /g, '')) || descLower.includes(basename)) score += 3;
      if (className && descLower.includes(className.toLowerCase())) score += 3;

      // Description keywords in file methods
      const methodNames = [...content.matchAll(/async\s+(\w+)\s*\(/g)].map(m => m[1].toLowerCase());
      for (const word of descWords) {
        if (methodNames.some(m => m.includes(word))) { score += 2; break; }
      }

      // POM code references a property that exists in this file
      const propRefs = [...pomCode.matchAll(/this\.(\w+)\./g)].map(m => m[1]);
      for (const ref of propRefs) {
        if (content.includes(`${ref} =`) || content.includes(`${ref}:`)) { score += 1; break; }
      }

      if (score > bestScore) { bestScore = score; bestPath = absPath; }
    }

    if (bestPath) log(`[Flow Generator] Best-match page file (score ${bestScore}): ${path.relative(rootDir, bestPath)}`);
    return bestPath;
  } catch {
    return null;
  }
}

/**
 * Returns the AI-generated methods as a string ready to be patched via applyPomPatch,
 * or null if Claude produced no usable methods.
 */
async function generateMissingMethods(
  missing:     Array<{ method: string; className: string }>,
  classSource: string,
  anthropic:   Anthropic,
  model:       string,
  log:         (msg: string) => void,
): Promise<string | null> {
  const methodList = missing.map(m => `  - ${m.className}.${m.method}()`).join('\n');
  log(`[Flow Generator] Generating ${missing.length} missing method(s):\n${methodList}`);

  // Build the list of EXISTING public property object names so the AI
  // cannot accidentally generate a method that shadows one of them.
  const existingPropObjects = [...classSource.matchAll(/\n\s*public\s+(\w+)\s*=/g)].map(m => m[1]);
  const propObjectsNote = existingPropObjects.length > 0
    ? `\n⚠ EXISTING PUBLIC PROPERTY OBJECTS (NEVER create a method with any of these names):\n${existingPropObjects.map(p => `  - ${p}`).join('\n')}\n  These are selector containers. A method with the same name would DESTROY the selector access pattern.\n  If the spec accesses this.<propName>.<key>, add the missing key to that property object instead.`
    : '';

  const prompt = `You are a Playwright QA architect. The test spec requires the following methods that are missing from the page class.
Generate ONLY the listed missing methods — nothing else.

MISSING METHODS (generate ONLY these):
${methodList}
${propObjectsNote}

EXISTING CLASS SOURCE (for context — do not rewrite, do not add extra methods):
\`\`\`typescript
${classSource.slice(0, 8000)}
\`\`\`

OUTPUT RULES:
- Generate ONLY the methods listed in MISSING METHODS above — do NOT invent extra helpers or orchestrators
- Output ONLY the method bodies, NO class wrapper, NO imports
- Mark each method with a comment: // [AI-generated]
- Write methods at column 0 (no leading indentation — the framework adds it)
- Use existing selector properties already in the class (e.g. this.contentPlaylistCreate.nameInput, this.experience.*)
  If a selector group property already exists, reference it — do NOT hardcode selector strings in method bodies
- NEVER generate a method whose name matches an EXISTING PUBLIC PROPERTY OBJECT (see above)
- NEVER generate an orchestrator method that calls all the other methods in sequence
- Follow the patterns you see in the class above
- Do NOT include a class declaration or closing brace

Example output:
// [AI-generated]
async visit(): Promise<void> {
  await this.page.goto(this.contentPlaylistPageElements.pageUrl, { waitUntil: 'domcontentloaded' });
}

// [AI-generated]
async fillExperienceName(name: string): Promise<void> {
  await this.page.locator(this.contentPlaylistCreate.nameInput).fill(name);
}`;

  const t0 = Date.now();
  const response = await streamMessage(anthropic, {
    model,
    max_tokens: 8192,
    system: 'You are a Playwright TypeScript automation expert. Output only method bodies — no class wrapper, no imports.',
    tools: [],
    messages: [{ role: 'user', content: prompt }],
  });
  if (response.usage) {
    trackTokens('repair-methods', response.usage.input_tokens, response.usage.output_tokens, Date.now() - t0);
  }

  let text = '';
  for (const block of response.content) {
    if (block.type === 'text') text += block.text;
  }

  // Extract from a typescript block if Claude wrapped it
  const blockMatch = text.match(/```(?:typescript|ts)\n([\s\S]*?)```/);
  const methods = blockMatch ? blockMatch[1].trim() : text.trim();
  return methods.length > 20 ? methods : null;
}

export async function generateFlow(options: FlowGeneratorOptions): Promise<FlowGeneratorResult> {
  const {
    url,
    flowDescription,
    outputDir      = 'tests/generated',
    headless       = true,
    verbose        = true,
    mode           = 'pom',
    maxTurns       = 40,
    tag,
    username,
    password,
    outputFileName,
  } = options;

  const model  = resolveModel(options.model);
  const pomDir = 'src/pages';
  const log    = (msg: string) => { if (verbose) console.log(msg); };

  // Scale turn budget to flow complexity — simple flows don't need 40 turns.
  const effectiveMaxTurns = estimateMaxTurns(flowDescription, maxTurns);

  log(`\n[Flow Generator] Mode: ${mode} | "${flowDescription}"`);
  log(`[Flow Generator] Target URL: ${url}`);
  log(`[Flow Generator] Model: ${model} | MaxTurns: ${effectiveMaxTurns}${effectiveMaxTurns < maxTurns ? ` (reduced from ${maxTurns})` : ''}`);

  // Launch MCP server and gather page-object infra in parallel — browser init
  // and file scanning are independent, so no reason to do them sequentially.
  const [{ server: mcpServer, cleanup }, existingInfra] = await Promise.all([
    createPlaywrightMcpServer(headless),
    gatherExistingInfra(process.cwd()),
  ]);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await mcpServer.connect(serverTransport);
  const mcpClient = new Client({ name: 'flow-generator-client', version: '1.0.0' });
  await mcpClient.connect(clientTransport);

  const { tools: mcpTools } = await mcpClient.listTools();
  const anthropicTools: Anthropic.Tool[] = mcpTools.map((tool) => ({
    name:         tool.name,
    description:  tool.description ?? tool.name,
    input_schema: (tool.inputSchema as Anthropic.Tool['input_schema']) ?? { type: 'object', properties: {} },
  }));
  log(`[Flow Generator] ${anthropicTools.length} browser tools available`);

  const anthropic   = createAnthropicClient();
  const credentials = (username && password) ? { username, password } : undefined;
  const systemPrompt = buildSystemPrompt(mode, credentials, existingInfra);

  const credHint    = credentials ? `` : '';
  const tagLine     = tag
    ? `\nTag to include in test.describe title: "${tag}" (add it verbatim, e.g. test.describe('Feature Name ${tag}', ...))`
    : '';
  const userPrompt  = `Target URL: ${url}
Flow to implement: ${flowDescription}
${tagLine}${credHint}

Follow the MANDATORY EXPLORATION PROTOCOL exactly:
1. Navigate to the URL and authenticate if needed
2. Survey the page structure
3. Execute EVERY step of the flow described above — do not skip any
4. After completing ALL steps, write the POM class and test spec

Remember: complete ALL exploration before writing any code.`;

  let result: FlowGeneratorResult;
  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: userPrompt }];

  try {
    const { text, actions, turns } = await runAgentLoop(
      anthropic, mcpClient, anthropicTools, systemPrompt, userPrompt, model, effectiveMaxTurns, log,
    );

    const fileName   = outputFileName ?? `${toFlowFileName(flowDescription)}.spec.ts`;
    const outputPath = path.join(outputDir, fileName);
    await fs.mkdir(outputDir,  { recursive: true });
    await fs.mkdir(pomDir,     { recursive: true });

    if (mode === 'pom') {
      const {
        parsePomDirective, applyPomPatch, compilationErrors, missingMethodsFromErrors,
        resolveClassFile, propertyKeyErrorsFromErrors, healPropertyKeyErrors,
        checkSpecPomConsistency, healUnknownFixtureErrors, healWrongClassMethodErrors,
      } = await import('../utils/pom-patcher');

      const { pomCode, testCode } = await retryExtractPomBlocks(text, anthropic, model, systemPrompt, messages, log);

      // ── Write the test spec ─────────────────────────────────────────────────
      // Embed generation URL as a recoverable tag so the healer always knows
      // which URL to navigate to — survives environment variable changes.
      const urlTag = `// @pfqa-url: ${url}\n`;
      const finalTestCode = urlTag + (tag ? injectTag(testCode, tag) : testCode);
      await fs.writeFile(outputPath, finalTestCode, 'utf-8');
      log(`\n[Flow Generator] Test: ${outputPath}`);

      // ── Handle POM block (patch EXISTING class only — never create new files) ─
      let pomPath: string | undefined;
      if (pomCode) {
        const directive = parsePomDirective(pomCode);

        if (directive.isAddition && directive.targetFile) {
          // AI emitted "// ADD TO: src/pages/foo.ts" — validate it targets an existing file
          const absTarget = path.join(process.cwd(), directive.targetFile);
          const targetExists = await fs.access(absTarget).then(() => true).catch(() => false);

          if (!targetExists) {
            // AI invented a non-existent file path — fall back to best-match existing file
            log(`[Flow Generator] WARN: ADD TO target "${directive.targetFile}" does not exist. Finding best-match existing page file...`);
            const fallback = await findBestMatchPageFile(process.cwd(), pomDir, pomCode, flowDescription, log);
            if (fallback) {
              log(`[Flow Generator] Redirecting patch → ${path.relative(process.cwd(), fallback)}`);
              try {
                await applyPomPatch(fallback, directive.cleanedCode, log);
                pomPath = fallback;
              } catch (patchErr) {
                log(`[Flow Generator] WARN: Fallback patch failed: ${patchErr instanceof Error ? patchErr.message : patchErr}`);
              }
            } else {
              log('[Flow Generator] WARN: No suitable existing page file found. POM code skipped.');
            }
          } else {
            try {
              await applyPomPatch(absTarget, directive.cleanedCode, log);
              pomPath = absTarget;
            } catch (patchErr) {
              log(`[Flow Generator] WARN: POM patch failed: ${patchErr instanceof Error ? patchErr.message : patchErr}`);
            }
          }
        } else if (!directive.isAddition && extractClassName(directive.cleanedCode)) {
          // AI tried to create a new class — refuse and warn
          log('[Flow Generator] WARN: AI attempted to create a new page class. This is not allowed.');
          log('  Finding best-match existing page file to patch instead...');
          const fallback = await findBestMatchPageFile(process.cwd(), pomDir, pomCode, flowDescription, log);
          if (fallback) {
            log(`[Flow Generator] Redirecting to existing file: ${path.relative(process.cwd(), fallback)}`);
            try {
              await applyPomPatch(fallback, directive.cleanedCode, log);
              pomPath = fallback;
            } catch (patchErr) {
              log(`[Flow Generator] WARN: Fallback patch failed: ${patchErr instanceof Error ? patchErr.message : patchErr}`);
            }
          }
        } else if (directive.isAddition && !directive.targetFile) {
          // Method bodies with no target — find best-match
          log('[Flow Generator] WARN: POM block has no // ADD TO: target. Finding best-match existing page file...');
          const fallback = await findBestMatchPageFile(process.cwd(), pomDir, pomCode, flowDescription, log);
          if (fallback) {
            try {
              await applyPomPatch(fallback, directive.cleanedCode, log);
              pomPath = fallback;
            } catch (patchErr) {
              log(`[Flow Generator] WARN: Patch failed: ${patchErr instanceof Error ? patchErr.message : patchErr}`);
            }
          }
        }
      } else {
        log('[Flow Generator] No POM block — spec uses existing page objects only.');
      }

      // ── Pre-compile consistency check ───────────────────────────────────────
      // Resolve ALL page files referenced by the spec (not just the patched one)
      // to run a thorough group-path consistency check across every fixture used.
      {
        const specSource = await fs.readFile(outputPath, 'utf-8').catch(() => '');
        const { buildFixtureClassMap: _buildMap, resolveClassFile: _resolve } =
          await import('../utils/pom-patcher');
        // Collect all POM files referenced by this spec via fixture variable access
        const allPomFiles: string[] = pomPath ? [pomPath] : [];
        const fixtureVarRe = /\b(\w+)\.(\w+)\.(\w+)\b/g;
        const fixtureClassMap = await _buildMap(process.cwd()).catch(() => new Map());
        for (const m of specSource.matchAll(fixtureVarRe)) {
          const className = fixtureClassMap.get(m[1]);
          if (!className) continue;
          const fp = await _resolve(className, process.cwd()).catch(() => null);
          if (fp && !allPomFiles.includes(fp)) allPomFiles.push(fp);
        }
        if (allPomFiles.length > 0) {
          const consistencyFixed = await checkSpecPomConsistency(
            outputPath, allPomFiles, process.cwd(), log,
          );
          if (consistencyFixed) {
            log('[Flow Generator] Pre-compile consistency check rewrote spec property paths.');
          }
        }
      }

      // ── Compile-and-repair loop (up to 3 attempts) ──────────────────────────
      // Check both the spec AND every POM file that was touched during generation.
      const touchedPoms = pomPath ? [pomPath] : [];
      const maxRepairs = 3;
      for (let attempt = 1; attempt <= maxRepairs; attempt++) {
        const errors = compilationErrors(outputPath, process.cwd(), touchedPoms);
        if (errors.length === 0) {
          log('[Flow Generator] TypeScript compilation clean — no repair needed.');
          break;
        }

        // ── Layer 1: heal unknown fixture variable names (TS2304) ──────────────
        const fixtureHealed = await healUnknownFixtureErrors(errors, outputPath, process.cwd(), log);
        if (fixtureHealed) {
          log('[Flow Generator] Fixture-name healing applied — re-checking compilation...');
          continue;
        }

        // ── Layer 2: remap methods called on the wrong fixture class ────────────
        // e.g. templatedExperiencePage.visitContentPlaylists() when that method
        // only exists on ContentPlaylistPage → remap to contentPlaylistPage.
        const wrongClassHealed = await healWrongClassMethodErrors(errors, outputPath, process.cwd(), log);
        if (wrongClassHealed) {
          log('[Flow Generator] Wrong-class fixture remap applied — re-checking compilation...');
          continue;
        }

        const missing = missingMethodsFromErrors(errors);
        if (missing.length === 0) {
          // ── Layer 3: heal wrong property group path (Property 'X' does not exist on type '{ ... }')
          const keyErrors = propertyKeyErrorsFromErrors(errors);
          if (keyErrors.length > 0) {
            const pomForKey = touchedPoms[0];
            if (pomForKey) {
              log(`[Flow Generator] Auto-healing ${keyErrors.length} property-key error(s)...`);
              const healed = await healPropertyKeyErrors(errors, outputPath, pomForKey, log);
              if (healed) {
                log('[Flow Generator] Property-key healing applied — re-checking compilation...');
                continue;
              }
            }
          }
          log(`[Flow Generator] WARN: ${errors.length} compile error(s) in generated files:`);
          for (const e of errors) log(`  ${e.file}(${e.line}): TS${e.code} ${e.message}`);
          break;
        }

        // ── Layer 4: generate missing methods — repair ALL classes in one pass ──
        log(`[Flow Generator] Repair attempt ${attempt}/${maxRepairs}: ${missing.length} missing method(s)...`);

        // Group by className so every class gets repaired in one attempt
        const byClass = new Map<string, typeof missing>();
        for (const m of missing) {
          const arr = byClass.get(m.className) ?? [];
          arr.push(m);
          byClass.set(m.className, arr);
        }

        let anyPatchApplied = false;
        for (const [targetClassName, methods] of byClass) {
          const classFilePath = await resolveClassFile(targetClassName, process.cwd());
          if (!classFilePath) {
            log(`[Flow Generator] WARN: Cannot locate source for class "${targetClassName}" — skipping.`);
            continue;
          }
          const classSource = await fs.readFile(classFilePath, 'utf-8');
          const newMethods  = await generateMissingMethods(methods, classSource, anthropic, model, log);
          if (!newMethods) {
            log(`[Flow Generator] WARN: generateMissingMethods returned nothing for "${targetClassName}".`);
            continue;
          }
          try {
            await applyPomPatch(classFilePath, newMethods, log);
            pomPath = classFilePath;
            if (!touchedPoms.includes(classFilePath)) touchedPoms.push(classFilePath);
            anyPatchApplied = true;
          } catch (patchErr) {
            log(`[Flow Generator] WARN: Repair patch failed for "${targetClassName}": ${patchErr instanceof Error ? patchErr.message : patchErr}`);
          }
        }
        if (!anyPatchApplied) {
          log('[Flow Generator] WARN: No patches applied in this repair attempt — stopping.');
          break;
        }
      }

      result = { outputPath, pomPath, actionsRecorded: actions.length, turnsUsed: turns };

      // ── Save generated requirements MD for future reference / healing ─────
      await saveGeneratedMd({
        url, flowDescription, outputPath, pomPath, outputDir, actions,
      }, log).catch(e => log(`[Flow Generator] WARN: could not save generated MD: ${e instanceof Error ? e.message : e}`));

    } else {
      let code = extractTestCode(text);
      if (!code) throw new Error('Claude did not produce any test code.');
      if (tag) code = injectTag(code, tag);
      const urlTagTest = `// @pfqa-url: ${url}\n`;
      await fs.writeFile(outputPath, urlTagTest + code, 'utf-8');
      log(`\n[Flow Generator] Test: ${outputPath}`);
      result = { outputPath, actionsRecorded: actions.length, turnsUsed: turns };

      // ── Save generated requirements MD for future reference / healing ─────
      await saveGeneratedMd({
        url, flowDescription, outputPath, pomPath: undefined, outputDir, actions,
      }, log).catch(e => log(`[Flow Generator] WARN: could not save generated MD: ${e instanceof Error ? e.message : e}`));
    }
  } finally {
    await mcpClient.close().catch(() => null);
    await cleanup();
  }

  log(`[Flow Generator] Browser actions recorded: ${result.actionsRecorded}`);
  return result;
}
