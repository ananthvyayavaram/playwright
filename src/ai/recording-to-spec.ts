// Converts a raw Playwright codegen recording directly into a POM class + framework spec
// in ONE AI call — no MCP browser session, no MD intermediate step.
//
// Token cost: ~1-2k tokens / ~15 seconds vs 40+ calls / 5 min via MCP generation.
// The recording already contains 100% of the locators — the AI only restructures.

import Anthropic from '@anthropic-ai/sdk';
import { createAnthropicClient, resolveModel } from './anthropic-client';
import { trackTokens } from '../utils/token-counter';
import { parseMissingMethods } from './pom-method-healer';
import { applyPomPatch } from '../utils/pom-patcher';
import { spawnSync } from 'child_process';
import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import { slugify } from '../../scripts/cli-utils';

// ─────────────────────────────────────────────────────────────────────────────

export interface RecordingToSpecOptions {
  rawRecording:   string;   // raw playwright codegen output
  featureTitle?:  string;   // hint for naming (inferred if omitted)
  outputDir?:     string;   // default: tests/generated
  pomDir?:        string;   // default: src/pages
  fixturesPath?:  string;   // default: src/fixtures/pageObjects.ts
  projectRoot?:   string;   // default: process.cwd()
  model?:         string;
  baseUrlEnvVar?: string;   // default: BASE_URL
  pomFileBase?:   string;   // explicit POM file base name (e.g. 'contentlibrary' → contentlibrary.page.ts)
  specFileBase?:  string;   // explicit spec file base name (defaults to pomFileBase)
}

export interface RecordingToSpecResult {
  specPath:   string;
  pomPath:    string;
  className:  string;  // e.g. ContentPlaylistPage
  fixtureName: string; // e.g. contentPlaylistPage
  isNewPom:   boolean; // true if POM was newly created
  tsClean:    boolean;
  tsErrors:   string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function toCamel(s: string): string {
  return s.charAt(0).toLowerCase() + s.slice(1);
}

/** Extract all existing fixture property names from pageObjects.ts */
function readExistingFixtures(fixturesPath: string): Map<string, string> {
  // Returns Map<fixtureName, importedClassName>
  const result = new Map<string, string>();
  if (!fsSync.existsSync(fixturesPath)) return result;
  const src = fsSync.readFileSync(fixturesPath, 'utf-8');
  // import FooPage from '../pages/foo.page'
  const importRe = /import\s+(\w+)\s+from\s+['"][^'"]+['"]/g;
  const classNames = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = importRe.exec(src)) !== null) classNames.add(m[1]);
  // fixture property: fooPage: async ({ page }, use) => ...
  const fixtureRe = /(\w+):\s*async\s*\(\s*\{[^}]*\}\s*,\s*use\s*\)\s*=>/g;
  while ((m = fixtureRe.exec(src)) !== null) {
    const prop = m[1];
    // map camelCase fixture → PascalCase class (best-effort)
    const candidate = prop.charAt(0).toUpperCase() + prop.slice(1);
    if (classNames.has(candidate)) result.set(prop, candidate);
  }
  return result;
}

/** Auto-patch pageObjects.ts to register a new POM class */
async function registerFixtureInFile(
  fixturesPath: string,
  pomRelPath:   string,   // e.g. ../pages/contentPlaylist.page  (relative to src/fixtures/)
  className:    string,   // e.g. ContentPlaylistPage
  fixtureName:  string,   // e.g. contentPlaylistPage
): Promise<void> {
  let src = await fs.readFile(fixturesPath, 'utf-8');

  // 1. Add import after last existing import line
  const lastImportIdx = src.lastIndexOf('\nimport ');
  const insertAfter = lastImportIdx !== -1
    ? src.indexOf('\n', lastImportIdx + 1)
    : src.indexOf('\n');
  const importLine = `\nimport ${className} from '${pomRelPath}';`;
  src = src.slice(0, insertAfter) + importLine + src.slice(insertAfter);

  // 2. Add type in extend<{...}> block — insert before the last `}>(`
  const extendTypeIdx = src.lastIndexOf('}>({');
  if (extendTypeIdx !== -1) {
    const typeLine = `\n  ${fixtureName}: ${className};`;
    src = src.slice(0, extendTypeIdx) + typeLine + '\n' + src.slice(extendTypeIdx);
  }

  // 3. Add fixture implementation — insert before the closing `});` of the extend block
  const closeIdx = src.lastIndexOf('});');
  if (closeIdx !== -1) {
    const implLine = `\n  ${fixtureName}: async ({ page }, use) => { await use(new ${className}(page)); },`;
    src = src.slice(0, closeIdx) + implLine + '\n' + src.slice(closeIdx);
  }

  await fs.writeFile(fixturesPath, src, 'utf-8');
}

// ─────────────────────────────────────────────────────────────────────────────
// AI conversion
// ─────────────────────────────────────────────────────────────────────────────

async function callAI(
  rawRecording:     string,
  featureTitle:     string | undefined,
  existingFixtures: Map<string, string>,
  baseUrlEnvVar:    string,
  anthropic:        Anthropic,
  model:            string,
): Promise<{ pomCode: string; specCode: string }> {

  const fixtureList = [...existingFixtures.entries()]
    .map(([prop, cls]) => `  ${prop}: ${cls}`)
    .join('\n') || '  (none yet)';

  const titleHint = featureTitle
    ? `Feature/test name hint: "${featureTitle}"`
    : 'Infer a concise feature name from the actions in the recording.';

  const prompt = `You are a senior Playwright automation engineer.
Convert the raw Playwright codegen recording below into our framework's Page Object Model structure.
The recording already has all the locators — just restructure it. ONE AI call, no browsing needed.

${titleHint}

════════════════════════════════════════════════════════════
RAW PLAYWRIGHT CODEGEN RECORDING
════════════════════════════════════════════════════════════
\`\`\`typescript
${rawRecording}
\`\`\`

════════════════════════════════════════════════════════════
EXISTING PAGE OBJECT FIXTURES  (reuse these if the feature matches)
════════════════════════════════════════════════════════════
${fixtureList}

════════════════════════════════════════════════════════════
FRAMEWORK PATTERNS  (match these exactly)
════════════════════════════════════════════════════════════

POM FILE PATTERN  (src/pages/featureName.page.ts):
\`\`\`typescript
import { Page, expect } from "@playwright/test";

export default class FeatureNamePage {
  constructor(public page: Page) {}

  // [AI-generated]
  async visit(): Promise<void> {
    await this.page.goto(\`\${process.env.${baseUrlEnvVar}}/path/to/feature\`, { waitUntil: 'domcontentloaded' });
  }

  // [AI-generated]
  async clickSomeButton(): Promise<void> {
    await this.page.getByRole('button', { name: 'Label' }).click();
  }

  // [AI-generated]
  async fillSomeField(value: string): Promise<void> {
    await this.page.getByRole('textbox', { name: 'Label' }).fill(value);
  }

  // [AI-generated]
  async verifySomethingVisible(): Promise<void> {
    await expect(this.page.getByRole('heading', { name: 'Title' })).toBeVisible();
  }
}
\`\`\`

SPEC FILE PATTERN  (tests/generated/featurename.spec.ts):
\`\`\`typescript
import test, { expect } from '../../src/fixtures/pageObjects';
import ENV from '../../src/utils/env';

test.describe('Feature Name @featurename', { tag: ['@feature', '@featurename'] }, () => {
  test.use({ viewport: { width: 1920, height: 1080 } });

  test('should do the recorded flow', { tag: ['@featurename'] },
    async ({ page, loginPage, featureNamePage }) => {
      test.setTimeout(300_000);

      await test.step('Login and navigate to feature page', async () => {
        await loginPage.loginToApplication(ENV.${baseUrlEnvVar});
        await featureNamePage.visit();
      });

      await test.step('Step description matching business action', async () => {
        await featureNamePage.someMethod();
      });

      await test.step('Verify expected outcome', async () => {
        await featureNamePage.verifySomething();
        await expect(page).toHaveURL(/pattern/, { timeout: 15_000 });
      });
    }
  );
});
\`\`\`

════════════════════════════════════════════════════════════
CONVERSION RULES — MUST FOLLOW ALL
════════════════════════════════════════════════════════════

1. CREDENTIALS — MANDATORY SECURITY RULE:
   ANY action filling an email/password/username field MUST become:
     await loginPage.loginToApplication(ENV.${baseUrlEnvVar});
   in the spec. NEVER put credentials in POM or spec. NEVER.

2. POM METHODS — extract every significant action as a named method:
   - One action = one method (click, fill, select, navigate, verify)
   - Method names: camelCase verbs — clickCreateButton, fillNameField, selectThemeOption
   - EVALUATE locators from the recording — keep them only if they are semantic (getByRole,
     getByLabel, getByPlaceholder, getByText). If they are CSS class, nth-child, or
     auto-generated IDs, UPGRADE them using the rules in rule 10 below.
   - Add \`await this.page.waitForLoadState('domcontentloaded', { timeout: 8_000 }).catch(() => {})\`
     after any navigation (page.goto or click that changes URL)

3. SPEC STEPS — group logically by business intent:
   - 3-8 test.step blocks (not one per POM method)
   - Step names describe WHAT the user is doing: "Create new playlist", "Fill in playlist details"
   - First step always: login + navigate
   - Last step: verify the outcome

4. FIXTURE REUSE — check the EXISTING FIXTURES list above:
   - If the feature/URL matches an existing fixture, USE IT — no new POM needed
   - If it's a new feature, create a new POM class

5. POM CLASS NAMING:
   - PascalCase + "Page" suffix: ContentPlaylistPage, UserPermissionsPage
   - File: camelCase + ".page.ts": contentPlaylist.page.ts, userPermissions.page.ts
   - Fixture property: camelCase, first char lowered: contentPlaylistPage

6. ENV USAGE in spec: ENV.${baseUrlEnvVar} (not process.env)
   ENV USAGE in POM: process.env.${baseUrlEnvVar}

7. UNIQUE VALUES: For any fill that creates a record (name, title),
   generate a unique value in the spec:
   const itemName = \`Feature \${new Date().toISOString().replace(/[:.]/g, '-')}\`;

8. OUTPUT: produce exactly TWO typescript code blocks separated by a divider.
   First block: the POM file (starts with "// FILE: src/pages/...")
   Second block: the spec file (starts with "// FILE: tests/generated/...")

9. AI-GENERATED LABELS — MANDATORY:
   Every method in the POM class MUST be prefixed with exactly:
     // [AI-generated]
   This applies to ALL methods: visit(), action methods, verify methods.
   Every locator property (if using page object locator fields) MUST also have:
     // [AI-generated]
   This label identifies AI-generated code for human reviewers.

10. SEMANTIC INTENT — INFER THE BEST LOCATOR FROM FIELD LABEL + ACTION:
   Read each action's field label and verb. A senior engineer KNOWS what element it
   is from the label alone — use this knowledge to produce the best locator:

   FIELD LABEL → ELEMENT TYPE → BEST LOCATOR STRATEGY
   ───────────────────────────────────────────────────────────────────────────────
   "Name", "Title", "Email",
   "Phone", "Username", "URL"      → <input> text variant   → getByLabel('Name')
   "Description", "Notes",
   "Comments", "Bio", "Body",
   "Message", "Details", "Content" → <textarea> or contenteditable rich-text
                                                             → getByLabel('Description')
                                                             or getByRole('textbox', {name:'Description'})
                                                             if codegen has .ql-editor / .ProseMirror
                                                             → locator('[contenteditable="true"]')
   "Date", "Start Date", "End Date" → date input or picker  → getByLabel('Start Date')
   "Time"                           → time input            → getByLabel('Time')
   "Price", "Amount", "Quantity"    → number input          → getByRole('spinbutton', {name:'Price'})
   "Status", "Type", "Theme",
   "Category", "Priority"          → combobox/select        → getByRole('combobox', {name:'Status'})
   "Tags", "Labels" (multi)        → multi-select combobox  → getByRole('combobox', {name:'Tags'})
   "Active", "Enabled", "Visible",
   "Published", "Allow"            → checkbox or switch     → getByRole('checkbox', {name:'Active'})
                                                               or getByRole('switch', {name:'Active'})
   "Upload", "Attach", "Browse"    → file input             → locator('input[type="file"]')
   "Save", "Create", "Submit",
   "Update", "Confirm", "Add"      → primary button         → getByRole('button', {name:'Save'})
   "Cancel", "Close", "Dismiss"    → secondary button       → getByRole('button', {name:'Cancel'})
   "Edit", "Delete" (row action)   → scoped button          → getByRole('row',{name:'Item'}).getByRole('button',{name:'Edit'})

   FORM FIELD ATTRIBUTE PRIORITY — for every input/textarea in the recording:
   Read ALL attributes and pick the best locator using this priority:
   1. name="..."       → page.locator('[name="description"]')   ← MOST STABLE
                          Reason: set by devs to match API field, never auto-generated,
                          unique in form, survives any UI library upgrade
   2. aria-label="..." → page.locator('[aria-label="Description"]')
   3. placeholder="..."→ page.getByPlaceholder('Enter description...')
   4. associated label → page.getByLabel('Description')
   5. id (non-generated only — no mantine-/ruid-/react-) → page.locator('#fieldId')

   EXAMPLE from real app HTML:
     <textarea name="description" id="mantine-r5b2s92nu" class="mantine-Input-input">
     → WRITE: page.locator('[name="description"]')    ✓ perfect — stable forever
     → NOT:   page.locator('#mantine-r5b2s92nu')      ✗ regenerates every render
     → NOT:   page.locator('.mantine-Input-input')    ✗ matches ALL inputs on the page

   CODEGEN UPGRADE RULE: when the codegen recording has a fragile locator, check the
   element's name/aria-label/placeholder attributes to produce the correct stable locator.
   You are reading human intent from codegen — never blindly copy a broken locator.

11. LOCATOR QUALITY — UPGRADE FRAGILE CODEGEN LOCATORS:
   Playwright codegen often produces fragile locators. When restructuring into POM,
   ALWAYS upgrade bad locators using these rules:

   PRIORITY ORDER (use the first that describes the element accurately):
     a) page.getByRole('button', { name: 'Label' })       ← best: semantic role + label
     b) page.getByLabel('Field Name')                     ← best for inputs associated to a label
     c) page.getByPlaceholder('Enter name...')            ← for inputs with placeholder
     d) page.getByText('Exact Text', { exact: true })     ← for static text/link elements
     e) page.locator('[data-testid="..."]')               ← stable test hook if present
     f) page.locator('[aria-label="..."]')                ← ARIA attribute fallback
     g) page.locator('label:has-text("Label") input')     ← label-relative for wrapped inputs
     h) page.getByRole('dialog').getByRole('button', ...) ← scoped role chain for modals
     i) xpath=//label[normalize-space()="Label"]//input   ← label-axis XPath as last resort

   ARIA ROLE vs HTML TAG — understand what getByRole() actually matches:
   ┌──────────────────────────────────┬─────────────────────────────────────────────┐
   │ HTML element                     │ ARIA role → correct Playwright locator      │
   ├──────────────────────────────────┼─────────────────────────────────────────────┤
   │ <textarea>                       │ textbox → getByRole('textbox', {name:'...'})│
   │ <input type="text">              │ textbox → getByRole('textbox', {name:'...'})│
   │ <div contenteditable="true">     │ textbox → getByRole('textbox', {name:'...'})│
   │ <div role="button">              │ button  → getByRole('button', {name:'...'}) │
   │ <span role="button">             │ button  → getByRole('button', {name:'...'}) │
   │ <span> / <div> (no role attr)    │ NO role → getByRole() WON'T find it         │
   │ <a href="#">                     │ link    → getByRole('link', {name:'...'})   │
   └──────────────────────────────────┴─────────────────────────────────────────────┘

   MANDATORY UPGRADES — if the codegen produced any of these, replace them:
   ┌─────────────────────────────────────────────────────────────────────────────┐
   │ FRAGILE CODEGEN                   → UPGRADED LOCATOR                       │
   ├─────────────────────────────────────────────────────────────────────────────┤
   │ .mantine-* class selector         → getByLabel() or getByRole()+name       │
   │ #mantine-RANDOMHASH               → getByRole('textbox', { name: 'Label' })│
   │ :nth-child(N) or :nth-of-type     → scope container + getByRole/getByLabel │
   │ bare CSS class (.btn, .input)     → getByRole() or getByLabel()            │
   │ #react-select-N / #ruid-HASH      → getByRole('combobox', { name: 'Label'})│
   │ locator('div').nth(N)             → scope to named parent + semantic query │
   │ locator('span').nth(N)            → page.getByText('Label', {exact:true})  │
   │                                     or :is(button,[role="button"],span,a)  │
   │                                          :has-text("Label")                │
   │ locator('span:has-text("Label")')  → check if role exists first:           │
   │  (when codegen used a span button)  getByRole('button', {name: 'Label'})  │
   │                                     if count=0 → page.getByText('Label',   │
   │                                        {exact:true}) scoped to container   │
   └─────────────────────────────────────────────────────────────────────────────┘

   NEAREST LABEL RULE: When you cannot determine a clean semantic locator from the
   recording alone, infer it from context clues in the recording:
   • Look at the text around the element: nearby labels, placeholders, aria-labels
   • Use the field name from the action (e.g. "fill name" → getByLabel('Name'))
   • Use the button text from .click() calls (e.g. 'Save' → getByRole('button', {name:'Save'}))
   • NEVER carry forward a Mantine/React auto-generated ID into the POM — always replace it.

OUTPUT FORMAT (EXACTLY):
\`\`\`typescript
// FILE: src/pages/featureName.page.ts
import { Page, expect } from "@playwright/test";
// ... full POM class
\`\`\`

---SPEC---

\`\`\`typescript
// FILE: tests/generated/featurename.spec.ts
import test, { expect } from '../../src/fixtures/pageObjects';
// ... full spec
\`\`\``;

  const t0 = Date.now();
  const response = await anthropic.messages.create({
    model,
    max_tokens: 8192,
    messages: [{ role: 'user', content: prompt }],
  });
  trackTokens(
    'recording-to-spec',
    response.usage?.input_tokens  ?? 0,
    response.usage?.output_tokens ?? 0,
    Date.now() - t0,
  );

  const textBlock = response.content.find((b): b is Anthropic.TextBlock => b.type === 'text');
  if (!textBlock?.text) throw new Error('AI returned no text content');

  const raw = textBlock.text;

  // Extract the two typescript blocks
  const blocks: string[] = [];
  const re = /```(?:typescript|ts)\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) blocks.push(m[1].trim());

  if (blocks.length < 2) {
    throw new Error(`Expected 2 typescript blocks in AI response, got ${blocks.length}. Raw:\n${raw.slice(0, 500)}`);
  }

  // The first block with "// FILE: src/pages" is POM; second is spec
  let pomCode  = blocks.find(b => b.includes('// FILE: src/pages') || (b.includes('export default class') && !b.includes('test.describe'))) ?? blocks[0];
  let specCode = blocks.find(b => b.includes('test.describe') || b.includes('// FILE: tests/generated')) ?? blocks[1];

  return { pomCode, specCode };
}

// ─────────────────────────────────────────────────────────────────────────────
// Extract file path + class name from AI-generated code
// ─────────────────────────────────────────────────────────────────────────────

function extractFilePath(code: string, fallbackDir: string, fallbackName: string): string {
  const m = code.match(/\/\/\s*FILE:\s*([^\n]+)/);
  if (m) return m[1].trim();
  return path.join(fallbackDir, `${fallbackName}.ts`);
}

function extractClassName(pomCode: string): string {
  const m = pomCode.match(/export\s+default\s+class\s+(\w+)/);
  return m ? m[1] : 'GeneratedPage';
}

// ─────────────────────────────────────────────────────────────────────────────
// Extract method bodies from a generated full class (for patching into existing file)
// ─────────────────────────────────────────────────────────────────────────────

function extractMethodBodiesForPatch(pomClassCode: string): string {
  const classMatch = pomClassCode.match(/\bclass\s+\w[^{]*\{/);
  if (!classMatch) return '';
  const bodyStart = pomClassCode.indexOf('{', classMatch.index!) + 1;
  const bodyEnd   = pomClassCode.lastIndexOf('}');
  if (bodyStart >= bodyEnd) return '';

  let body = pomClassCode.slice(bodyStart, bodyEnd);

  // Remove single-line constructor: constructor(public page: Page) {}
  body = body.replace(/[ \t]*constructor\s*\([^)]*\)\s*\{[^{}]*\}\s*/g, '\n');

  // Detect minimum indentation of non-empty lines and strip it
  const lines = body.split('\n');
  const contentLines = lines.filter(l => l.trim().length > 0);
  if (!contentLines.length) return '';

  const minIndent = contentLines.reduce((min, l) => {
    const m = l.match(/^(\s+)/);
    return Math.min(min, m ? m[1].length : 0);
  }, Infinity);

  const strip = isFinite(minIndent) ? minIndent : 0;
  return lines.map(l => l.slice(strip)).join('\n').trim();
}

// ─────────────────────────────────────────────────────────────────────────────
// Main conversion function
// ─────────────────────────────────────────────────────────────────────────────

export async function convertRecordingToSpec(
  opts: RecordingToSpecOptions,
): Promise<RecordingToSpecResult> {
  const {
    rawRecording,
    featureTitle,
    outputDir    = 'tests/generated',
    pomDir       = 'src/pages',
    fixturesPath = 'src/fixtures/pageObjects.ts',
    projectRoot  = process.cwd(),
    model,
    baseUrlEnvVar = 'BASE_URL',
  } = opts;

  const absFixtures = path.resolve(projectRoot, fixturesPath);
  const absPomDir   = path.resolve(projectRoot, pomDir);
  const absSpecDir  = path.resolve(projectRoot, outputDir);

  const existingFixtures = readExistingFixtures(absFixtures);

  const anthropic      = createAnthropicClient();
  const resolvedModel  = resolveModel(model ?? 'claude-sonnet-5');

  // ── AI call ────────────────────────────────────────────────────────────────
  const { pomCode, specCode } = await callAI(
    rawRecording,
    featureTitle,
    existingFixtures,
    baseUrlEnvVar,
    anthropic,
    resolvedModel,
  );

  // ── Extract metadata from generated code ──────────────────────────────────
  const className   = extractClassName(pomCode);
  const fixtureName = toCamel(className.replace(/Page$/, '') + 'Page');

  // Derive file paths
  const pomFileRelRaw  = extractFilePath(pomCode,  pomDir,  slugify(className.replace(/Page$/, '')) + '.page');
  const specFileRelRaw = extractFilePath(specCode, outputDir, slugify(featureTitle ?? className.replace(/Page$/, '')) + '.spec');

  // Ensure .ts extension and correct dirs
  const pomFileRel  = pomFileRelRaw.endsWith('.ts')  ? pomFileRelRaw  : pomFileRelRaw + '.ts';
  const specFileRel = specFileRelRaw.endsWith('.ts') ? specFileRelRaw : specFileRelRaw + '.ts';

  const absPomPath  = path.resolve(projectRoot, pomFileRel);
  const absSpecPath = path.resolve(projectRoot, specFileRel);

  // Clean the // FILE: comment from code before writing
  const cleanPom  = pomCode.replace(/^\/\/\s*FILE:[^\n]*\n/, '').trim() + '\n';
  const cleanSpec = specCode.replace(/^\/\/\s*FILE:[^\n]*\n/, '').trim() + '\n';

  // ── Write files ────────────────────────────────────────────────────────────
  await fs.mkdir(path.dirname(absPomPath),  { recursive: true });
  await fs.mkdir(path.dirname(absSpecPath), { recursive: true });

  const isNewPom = !fsSync.existsSync(absPomPath);
  if (isNewPom) {
    await fs.writeFile(absPomPath, cleanPom, 'utf-8');
  } else {
    // File already exists — patch only new methods in rather than overwriting.
    // This preserves manually written methods and avoids duplicate declarations.
    const methodBodies = extractMethodBodiesForPatch(cleanPom);
    if (methodBodies) {
      await applyPomPatch(absPomPath, methodBodies, msg => console.log(msg));
    }
  }
  await fs.writeFile(absSpecPath, cleanSpec, 'utf-8');

  // ── Register new POM class in fixtures if needed ──────────────────────────
  const alreadyRegistered = [...existingFixtures.values()].includes(className);
  if (!alreadyRegistered) {
    // Relative import path from src/fixtures/ to src/pages/...
    const relImport = path
      .relative(path.dirname(absFixtures), absPomPath)
      .replace(/\.ts$/, '')
      .replace(/\\/g, '/');
    const importPath = relImport.startsWith('.') ? relImport : './' + relImport;

    await registerFixtureInFile(absFixtures, importPath, className, fixtureName);
  }

  // ── TypeScript check ───────────────────────────────────────────────────────
  const tsCheck = spawnSync('npx', ['tsc', '--noEmit'], {
    encoding: 'utf-8',
    stdio: ['inherit', 'pipe', 'pipe'],
    cwd: projectRoot,
  });

  const tsOutput = (tsCheck.stdout ?? '') + (tsCheck.stderr ?? '');
  const tsClean  = tsCheck.status === 0 || tsCheck.status === null;
  const tsErrors = tsOutput.split('\n').filter(l => l.includes('error TS'));

  // ── Auto-heal missing POM methods if TS errors present ────────────────────
  if (!tsClean) {
    const specRelForErrors = path.relative(projectRoot, absSpecPath);
    const specErrors = tsErrors.filter(l => l.includes(specRelForErrors));
    const missing    = parseMissingMethods(specErrors);

    if (missing.length > 0) {
      const { healMissingPomMethods } = await import('./pom-method-healer');
      const healResult = await healMissingPomMethods(absSpecPath, absPomPath, specErrors, model);
      if (healResult.fixed) {
        const tsCheck2 = spawnSync('npx', ['tsc', '--noEmit'], {
          encoding: 'utf-8', stdio: ['inherit', 'pipe', 'pipe'], cwd: projectRoot,
        });
        const clean2   = tsCheck2.status === 0 || tsCheck2.status === null;
        const errors2  = ((tsCheck2.stdout ?? '') + (tsCheck2.stderr ?? '')).split('\n').filter(l => l.includes('error TS'));
        return {
          specPath:    absSpecPath,
          pomPath:     absPomPath,
          className,   fixtureName, isNewPom,
          tsClean:     clean2,
          tsErrors:    errors2,
        };
      }
    }
  }

  return {
    specPath: absSpecPath,
    pomPath:  absPomPath,
    className, fixtureName, isNewPom,
    tsClean,
    tsErrors,
  };
}
