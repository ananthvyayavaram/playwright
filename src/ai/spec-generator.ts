// Generates a Playwright spec + POM from a requirements description using one AI call.
// Used by scripts/flow.ts as a simpler alternative to the full MCP browser flow.

import Anthropic from '@anthropic-ai/sdk';
import { createAnthropicClient, resolveModel } from './anthropic-client';
import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';

export interface SpecGeneratorOptions {
  url:             string;
  flowDescription: string;
  flowTitle:       string;
  outputDir?:      string;   // default: tests/generated
  pomDir?:         string;   // default: src/pages
  fixturesPath?:   string;   // default: src/fixtures/pageObjects.ts
  outputFileName?: string;   // explicit spec filename (e.g. login.spec.ts)
  projectRoot?:    string;
  model?:          string;
  baseUrlEnvVar?:  string;   // default: BASE_URL
}

export interface SpecGeneratorResult {
  specPath:    string;
  pomPath?:    string;
  className?:  string;
  fixtureName?: string;
}

function toCamel(s: string): string {
  return s.charAt(0).toLowerCase() + s.slice(1);
}

function slugify(str: string): string {
  return str.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
}

async function callAI(
  opts: SpecGeneratorOptions,
  anthropic: Anthropic,
  model: string,
): Promise<{ pomCode: string; specCode: string }> {
  const baseUrlEnvVar = opts.baseUrlEnvVar ?? 'BASE_URL';

  const prompt = `You are a senior Playwright automation engineer.
Generate a complete Playwright test spec AND a Page Object Model class for the requirement below.
Use ONE AI call — produce POM + spec directly from the description.

URL: ${opts.url}
Feature: ${opts.flowTitle}

REQUIREMENT:
${opts.flowDescription}

════════════════════════════════════════════════════════════
FRAMEWORK PATTERNS (match these exactly)
════════════════════════════════════════════════════════════

POM FILE PATTERN  (src/pages/featureName.page.ts):
\`\`\`typescript
import { Page, expect } from "@playwright/test";

export default class FeatureNamePage {
  constructor(public page: Page) {}

  // [AI-generated]
  async visit(): Promise<void> {
    await this.page.goto(\`\${process.env.${baseUrlEnvVar}}/path\`, { waitUntil: 'domcontentloaded' });
  }

  // [AI-generated]
  async clickSomeButton(): Promise<void> {
    await this.page.getByRole('button', { name: 'Label' }).click();
  }

  // [AI-generated]
  async verifySomething(): Promise<void> {
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

  test('should complete the flow', { tag: ['@featurename'] },
    async ({ page, loginPage, featureNamePage }) => {
      test.setTimeout(300_000);

      await test.step('Login and navigate', async () => {
        await loginPage.loginToApplication(ENV.${baseUrlEnvVar});
        await featureNamePage.visit();
      });

      await test.step('Perform the action', async () => {
        await featureNamePage.clickSomeButton();
      });

      await test.step('Verify outcome', async () => {
        await featureNamePage.verifySomething();
      });
    }
  );
});
\`\`\`

RULES:
1. Every POM method MUST have // [AI-generated] comment above it
2. Credentials go through loginPage.loginToApplication(ENV.${baseUrlEnvVar}) — never hardcode them
3. Use semantic locators (getByRole, getByLabel, getByPlaceholder)
4. 3-6 test.step blocks grouped by business intent
5. ENV.${baseUrlEnvVar} in spec, process.env.${baseUrlEnvVar} in POM

OUTPUT: exactly TWO typescript blocks separated by ---SPEC---

\`\`\`typescript
// FILE: src/pages/featureName.page.ts
// ... full POM
\`\`\`

---SPEC---

\`\`\`typescript
// FILE: tests/generated/featurename.spec.ts
// ... full spec
\`\`\``;

  const response = await anthropic.messages.create({
    model,
    max_tokens: 6000,
    messages: [{ role: 'user', content: prompt }],
  });

  const textBlock = response.content.find((b): b is Anthropic.TextBlock => b.type === 'text');
  if (!textBlock?.text) throw new Error('AI returned no text content');

  const blocks: string[] = [];
  const re = /```(?:typescript|ts)\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(textBlock.text)) !== null) blocks.push(m[1].trim());

  if (blocks.length < 2) {
    throw new Error(`Expected 2 code blocks, got ${blocks.length}`);
  }

  const pomCode  = blocks.find(b => b.includes('export default class') && !b.includes('test.describe')) ?? blocks[0];
  const specCode = blocks.find(b => b.includes('test.describe')) ?? blocks[1];

  return { pomCode, specCode };
}

function extractClassName(pomCode: string): string {
  const m = pomCode.match(/export\s+default\s+class\s+(\w+)/);
  return m ? m[1] : 'GeneratedPage';
}

function extractFilePath(code: string, fallbackDir: string, fallbackName: string): string {
  const m = code.match(/\/\/\s*FILE:\s*([^\n]+)/);
  if (m) return m[1].trim();
  return path.join(fallbackDir, `${fallbackName}.ts`);
}

async function registerFixture(
  fixturesPath: string,
  pomRelPath:   string,
  className:    string,
  fixtureName:  string,
): Promise<void> {
  if (!fsSync.existsSync(fixturesPath)) return;
  let src = await fs.readFile(fixturesPath, 'utf-8');

  // Check if already registered
  if (src.includes(`import ${className}`) || src.includes(`${fixtureName}:`)) return;

  const lastImportIdx = src.lastIndexOf('\nimport ');
  const insertAfter   = lastImportIdx !== -1 ? src.indexOf('\n', lastImportIdx + 1) : src.indexOf('\n');
  src = src.slice(0, insertAfter) + `\nimport ${className} from '${pomRelPath}';` + src.slice(insertAfter);

  const extendTypeIdx = src.lastIndexOf('}>({');
  if (extendTypeIdx !== -1)
    src = src.slice(0, extendTypeIdx) + `\n  ${fixtureName}: ${className};` + '\n' + src.slice(extendTypeIdx);

  const closeIdx = src.lastIndexOf('});');
  if (closeIdx !== -1)
    src = src.slice(0, closeIdx) + `\n  ${fixtureName}: async ({ page }, use) => { await use(new ${className}(page)); },` + '\n' + src.slice(closeIdx);

  await fs.writeFile(fixturesPath, src, 'utf-8');
}

export async function generateSpecFromDescription(
  opts: SpecGeneratorOptions,
): Promise<SpecGeneratorResult> {
  const {
    outputDir    = 'tests/generated',
    pomDir       = 'src/pages',
    fixturesPath = 'src/fixtures/pageObjects.ts',
    projectRoot  = process.cwd(),
    model,
    outputFileName,
  } = opts;

  const anthropic = createAnthropicClient();
  const resolved  = resolveModel(model ?? 'claude-sonnet-5');

  const { pomCode, specCode } = await callAI(opts, anthropic, resolved);

  const className   = extractClassName(pomCode);
  const fixtureName = toCamel(className.replace(/Page$/, '') + 'Page');

  const pomFileRel  = extractFilePath(pomCode,  pomDir,    slugify(className.replace(/Page$/, '')) + '.page');
  const specSlug    = outputFileName ?? slugify(opts.flowTitle) + '.spec';
  const specFileRel = extractFilePath(specCode, outputDir, specSlug);

  const pomFinal  = pomFileRel.endsWith('.ts')  ? pomFileRel  : pomFileRel  + '.ts';
  const specFinal = specFileRel.endsWith('.ts') ? specFileRel : specFileRel + '.ts';

  const absPomPath  = path.resolve(projectRoot, pomFinal);
  const absSpecPath = path.resolve(projectRoot, specFinal);

  const cleanPom  = pomCode.replace(/^\/\/\s*FILE:[^\n]*\n/, '').trim() + '\n';
  const cleanSpec = specCode.replace(/^\/\/\s*FILE:[^\n]*\n/, '').trim() + '\n';

  await fs.mkdir(path.dirname(absPomPath),  { recursive: true });
  await fs.mkdir(path.dirname(absSpecPath), { recursive: true });

  await fs.writeFile(absPomPath,  cleanPom,  'utf-8');
  await fs.writeFile(absSpecPath, cleanSpec, 'utf-8');

  const absFixtures = path.resolve(projectRoot, fixturesPath);
  const relImport   = path.relative(path.dirname(absFixtures), absPomPath)
    .replace(/\.ts$/, '').replace(/\\/g, '/');
  await registerFixture(absFixtures, relImport.startsWith('.') ? relImport : './' + relImport, className, fixtureName);

  return { specPath: absSpecPath, pomPath: absPomPath, className, fixtureName };
}
