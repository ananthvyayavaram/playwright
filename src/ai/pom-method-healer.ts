// Automatically generates and injects missing POM methods when TypeScript reports
// "Property 'X' does not exist on type 'Y'" — no browser session needed.
import Anthropic from '@anthropic-ai/sdk';
import { createAnthropicClient, resolveModel } from './anthropic-client';
import { trackTokens } from '../utils/token-counter';
import fs from 'fs/promises';

export interface PomHealResult {
  fixed:        boolean;
  methodsAdded: string[];
  error?:       string;
}

// Parse TS error lines like:
//   "tests/generated/x.spec.ts(19,35): error TS2339: Property 'clickExperiencesIcon' does not exist on type 'ContentPlaylistPage'."
export function parseMissingMethods(tsErrors: string[]): string[] {
  const methods: string[] = [];
  for (const line of tsErrors) {
    const m = line.match(/Property '(\w+)' does not exist on type '(\w+)'/);
    if (m) methods.push(m[1]);
  }
  return [...new Set(methods)];
}

// Extract the surrounding test.step block for a method call in the spec.
function getMethodUsageContext(specSource: string, methodName: string): string {
  const lines = specSource.split('\n');
  const contexts: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].includes(`${methodName}(`)) continue;

    // Walk back to find the enclosing test.step(
    let stepStart = i;
    for (let j = i; j >= Math.max(0, i - 30); j--) {
      if (lines[j].includes('test.step(')) { stepStart = j; break; }
    }
    // Walk forward to find the closing })
    let stepEnd = Math.min(i + 3, lines.length - 1);
    for (let j = i + 1; j < Math.min(i + 30, lines.length); j++) {
      const trimmed = lines[j].trim();
      if (trimmed === '});' || trimmed === '});') { stepEnd = j; break; }
    }

    contexts.push(lines.slice(stepStart, stepEnd + 1).join('\n'));
  }

  return contexts.join('\n\n') || `  await page.${methodName}(...)`;
}

export async function healMissingPomMethods(
  specPath: string,
  pomPath:  string,
  tsErrors: string[],
  model?:   string,
): Promise<PomHealResult> {
  const missingMethods = parseMissingMethods(tsErrors);
  if (!missingMethods.length) {
    return { fixed: false, methodsAdded: [], error: 'No missing-method TS errors found' };
  }

  let specSource: string;
  let pomSource:  string;
  try {
    [specSource, pomSource] = await Promise.all([
      fs.readFile(specPath, 'utf-8'),
      fs.readFile(pomPath,  'utf-8'),
    ]);
  } catch (err) {
    return { fixed: false, methodsAdded: [], error: `Cannot read files: ${(err as Error).message}` };
  }

  // Build per-method usage blocks
  const usageSection = missingMethods.map(m => {
    const ctx = getMethodUsageContext(specSource, m);
    return `### Method: \`${m}\`\nUsage in spec:\n\`\`\`typescript\n${ctx}\n\`\`\``;
  }).join('\n\n');

  const prompt = `You are an expert Playwright Page Object Model developer.
A test spec calls ${missingMethods.length} method(s) that do not yet exist on the POM class.
Generate ONLY the missing method implementations so the spec compiles and runs correctly.

═══════════════════════════════════════════════════════════
EXISTING POM CLASS  (study the patterns — DO NOT repeat existing methods)
═══════════════════════════════════════════════════════════
\`\`\`typescript
${pomSource}
\`\`\`

═══════════════════════════════════════════════════════════
MISSING METHODS  (${missingMethods.length} total: ${missingMethods.join(', ')})
═══════════════════════════════════════════════════════════
${usageSection}

═══════════════════════════════════════════════════════════
STRICT RULES
═══════════════════════════════════════════════════════════
1. Output ONLY a single \`\`\`typescript block — nothing else.
2. The block contains ONLY the new method bodies (no class wrapper, no imports, no existing methods).
3. Match indentation and style of existing POM methods (2-space indent inside class).
4. Locator strategy (pick the MOST RELIABLE for each):
   - Buttons:   this.page.getByRole('button', { name: '...' }) or this.page.locator('button:has-text("...")')
   - Links:     this.page.getByRole('link', { name: '...' })
   - Nav icons: this.page.locator('[data-testid="..."]') or this.page.locator('svg[aria-label="..."]')
   - Inputs:    this.page.getByPlaceholder('...') or this.page.locator('#id')
5. For methods with parameters (e.g. navigateToContentPageSettings(name: string)):
   - Infer the parameter type and purpose from how it is called in the spec.
6. For verify methods (e.g. verifySaveButtonVisible): use expect(locator).toBeVisible().
7. For navigate methods: use this.page.goto(\`\${process.env.BASE_URL}/...\`) or navigate via UI clicks.
8. Add await this.page.waitForLoadState('domcontentloaded', { timeout: 8_000 }).catch(() => {}) after navigation.
9. Wrap click + navigation actions in try/catch if the step could legitimately be skipped.

OUTPUT (ONLY this, no extra text):
\`\`\`typescript
  // [AI-generated]
  async firstMissingMethod(): Promise<void> {
    // ...
  }

  // [AI-generated]
  async secondMissingMethod(param: string): Promise<void> {
    // ...
  }
\`\`\``;

  const t0       = Date.now();
  const anthropic = createAnthropicClient();
  const resolvedModel = resolveModel(model ?? 'claude-sonnet-5');

  let responseText: string;
  try {
    const response = await anthropic.messages.create({
      model:      resolvedModel,
      max_tokens: 4096,
      messages:   [{ role: 'user', content: prompt }],
    });
    trackTokens(
      'pom-method-heal',
      response.usage?.input_tokens  ?? 0,
      response.usage?.output_tokens ?? 0,
      Date.now() - t0,
    );
    const textBlock = response.content.find((b): b is Anthropic.TextBlock => b.type === 'text');
    if (!textBlock?.text) {
      return { fixed: false, methodsAdded: missingMethods, error: 'AI returned no text content' };
    }
    responseText = textBlock.text.trim();
  } catch (err) {
    return { fixed: false, methodsAdded: [], error: `AI call failed: ${(err as Error).message}` };
  }

  // Extract the typescript code block
  const fenced = responseText.match(/```(?:typescript|ts)?\n([\s\S]*?)```/);
  const newMethods = (fenced ? fenced[1] : responseText).trimEnd();

  if (!newMethods.trim()) {
    return { fixed: false, methodsAdded: [], error: 'AI returned empty method block' };
  }

  // Inject before the last `}` in the POM (the class closing brace)
  const closingIdx = pomSource.lastIndexOf('}');
  if (closingIdx === -1) {
    return { fixed: false, methodsAdded: [], error: 'Cannot locate closing } in POM file' };
  }

  // Ensure correct 2-space indentation inside the class
  const indented = newMethods
    .split('\n')
    .map(l => (l.trim() === '' ? '' : l.startsWith('  ') ? l : '  ' + l))
    .join('\n');

  const updatedPom =
    pomSource.slice(0, closingIdx).trimEnd() +
    '\n\n' + indented + '\n\n}\n';

  await fs.writeFile(pomPath, updatedPom, 'utf-8');
  return { fixed: true, methodsAdded: missingMethods };
}
