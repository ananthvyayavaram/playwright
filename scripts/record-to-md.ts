#!/usr/bin/env tsx
/**
 * record-to-md — Interactive browser recording → AI-generated requirements MD
 *
 * Opens a Playwright codegen browser. The user performs their test flow naturally.
 * When they close the browser, the raw Playwright recording is fed to Claude,
 * which converts it into a structured requirements MD file that the flow generator
 * can immediately use.
 *
 * Usage:
 *   npm run record -- --url <app-url>
 *   npm run record -- --url <app-url> --output requirements/my-feature.md
 *   npm run record -- --url <app-url> --title "Create Content Playlist"
 *
 * The generated MD can be used immediately with:
 *   npm run flow -- requirements/<output-name>.md
 */

import 'dotenv/config';
import dotenv from 'dotenv';
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import readline from 'readline/promises';
import Anthropic from '@anthropic-ai/sdk';
import { createAnthropicClient, resolveModel } from '../src/ai/anthropic-client';
import { parseArgs, slugify, promptForUrl } from './cli-utils';

const PROJECT_ROOT = process.cwd();

// ── Extract base URL from recording ───────────────────────────────────────────

function extractBaseUrlFromRecording(recording: string): string {
  // First page.goto() call is the entry point
  const gotoMatch = recording.match(/page\.goto\(['"`](https?:\/\/[^'"`]+)['"`]/);
  if (gotoMatch) {
    try {
      const u = new URL(gotoMatch[1]);
      return `${u.origin}${u.pathname}`;
    } catch { /* fall through */ }
  }
  return '';
}

// ── AI conversion ──────────────────────────────────────────────────────────────

async function convertRecordingToMd(
  rawRecording: string,
  baseUrl:      string,
  featureTitle: string | undefined,
  anthropic:    Anthropic,
  model:        string,
): Promise<string> {

  const titleHint = featureTitle
    ? `The user indicated this test is about: "${featureTitle}". Use that as the test case title.`
    : 'Infer a descriptive title from the actions performed.';

  const prompt = `You are a senior Business Analyst and QA lead converting a raw Playwright browser recording into a structured test case requirements file.

The recording shows EXACTLY what a user did in the browser, step by step.
Your job is to understand the BUSINESS INTENT behind each action and write clear, human-readable test steps.

${titleHint}

RECORDING (raw Playwright codegen output):
\`\`\`typescript
${rawRecording}
\`\`\`

BASE URL (entry point of the recording): ${baseUrl || '(extract from recording)'}

════════════════════════════════════════════════════════
OUTPUT INSTRUCTIONS — produce ONLY the MD file, nothing else
════════════════════════════════════════════════════════

Produce a requirements MD file in this EXACT format:

---
baseUrl: <FULL URL of the first page.goto() call>
outputDir: tests/generated
mode: pom
headed: true
---

# <Module/Feature Name> — Test Requirements

<One sentence describing what this requirements file covers.>

---

## <Test Case Title — action-focused, e.g. "Create Content Playlist" or "Delete User Account">

<2–3 sentences describing the business objective of this test flow.>
If redirected to sign-in, log in with the provided credentials.

<Numbered steps. Each step must be ONE plain English sentence.>
  1. Navigate to the <feature page name> page.
  2. Click the "<button label>" button.
  3. In the modal that opens, fill in the <Field Name> field with a unique test value (include current timestamp for uniqueness).
  4. Select "<option>" from the <dropdown name> dropdown.
  5. Click the "<submit button label>" button to submit.
  6. Verify <specific observable outcome — URL pattern, visible element, success message>.

---

CONVERSION RULES:
1. CREDENTIALS SECURITY — MANDATORY:
   - Any step that fills an email/password/username field → replace with:
     "If redirected to sign-in, log in with the provided credentials."
   - NEVER include actual email addresses, passwords, or usernames in the output.

2. PLAIN ENGLISH ONLY:
   - Never write code, CSS selectors, XPaths, or locator strings in the steps.
   - Convert "page.getByRole('button', {name: 'Create Experience'})" → Click the "Create Experience" button.
   - Convert "page.fill('[data-testid=name]', 'Test')" → Fill in the Name field.
   - Convert "page.waitForURL('/editor/')" → Verify the editor opens (URL should contain /editor/).

3. MODAL CONTEXT:
   - When you see page.getByRole('dialog') or locators chained inside a dialog:
     → Describe as "In the modal that opens" or "In the [name] dialog"

4. UNIQUENESS for created items:
   - Any fill action for a "name", "title", or "label" field should include:
     "(use a unique name — include current date/time to avoid duplicates)"

5. NAVIGATION:
   - page.goto('url') → "Navigate to the [page name derived from URL path] page."
   - page.waitForURL('pattern') → "Verify the page navigates to [what the URL represents]."

6. ASSERTIONS / VERIFICATION:
   - expect(...).toBeVisible() → "Verify [element description] is visible."
   - expect(...).toHaveURL(pattern) → "Verify the URL contains [pattern]."
   - expect(...).toHaveText(text) → "Verify [element] shows the text '[text]'."

7. WIZARD STEPS:
   - If you see repeated dialog interactions → describe as a multi-step wizard:
     "In the wizard that opens: Step 1 → ... Step 2 → ..."

8. KEEP IT CONCISE:
   - One step = one action or one verification.
   - Don't merge two clicks into one step.
   - Don't describe implementation details — describe WHAT THE USER DOES and WHAT THEY SEE.

Produce ONLY the MD file content. No preamble, no explanation, just the MD.`;

  const response = await anthropic.messages.create({
    model,
    max_tokens: 8192,
    messages: [{ role: 'user', content: prompt }],
  });

  // Find the first text block — LiteLLM/Anthropic may return mixed content types
  const textBlock = response.content.find(
    (block): block is Anthropic.TextBlock => block.type === 'text'
  );

  if (!textBlock?.text) {
    const blockTypes = response.content.map(b => b.type).join(', ') || 'empty';
    throw new Error(
      `AI returned no text content (blocks: [${blockTypes}], stop_reason: ${response.stop_reason})`
    );
  }

  const text = textBlock.text.trim();

  // If Claude wrapped in a code block, unwrap it
  const fenced = text.match(/^```(?:markdown|md)?\n([\s\S]*?)```\s*$/);
  return fenced ? fenced[1].trim() : text;
}

// ── Interactive prompts ────────────────────────────────────────────────────────

async function promptForTitle(defaultTitle: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(
      `\n  Enter a title for this test case (or press Enter to let AI decide):\n  > `,
    );
    return answer.trim() || defaultTitle;
  } finally {
    rl.close();
  }
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  const testEnv = (process.env.test_env ?? process.env.TEST_ENV ?? 'qa').toLowerCase();
  dotenv.config({ path: `helper/env/.env.${testEnv}`, override: false });

  const flags = parseArgs(process.argv.slice(2));

  const urlFlag     = flags['url']    as string | undefined;
  const outputFlag  = flags['output'] as string | undefined;
  const titleFlag   = flags['title']  as string | undefined;
  const modelFlag   = flags['model']  as string | undefined;
  const skipPrompt  = flags['yes']    === true;

  // Default URL from flag or env — always ask the user to confirm/override
  const defaultUrl =
    urlFlag ??
    process.env.BASE_URL ??
    process.env.BASE_URL_STAGING ??
    process.env.BASE_URL ?? '';

  console.log('');
  console.log('╔════════════════════════════════════════════════════════╗');
  console.log('║   Record-to-MD  ·  Playwright Codegen + Claude AI     ║');
  console.log('╚════════════════════════════════════════════════════════╝');

  // Always ask user to confirm / enter the URL
  const targetUrl = await promptForUrl(defaultUrl);

  console.log('');
  console.log(`  URL    : ${targetUrl}`);
  console.log(`  Output : ${outputFlag ?? 'requirements/<auto-named>.md'}`);
  console.log('');
  console.log('  HOW TO USE:');
  console.log('  ─────────────────────────────────────────────────────');
  console.log('  1. The browser opens at the URL above.');
  console.log('  2. Perform your COMPLETE test flow as a real user would.');
  console.log('     ✓ Login, navigate, click buttons, fill forms, submit.');
  console.log('     ✓ Every action you take is recorded automatically.');
  console.log('     ✓ You can also add assertions from the Playwright toolbar.');
  console.log('  3. When the flow is complete, CLOSE the browser window.');
  console.log('  4. Claude AI converts your recording into a requirements MD.');
  console.log('  ─────────────────────────────────────────────────────');
  console.log('');
  console.log('  Opening browser...');
  console.log('');

  // Temp file for the raw recording
  const tmpFile = path.join(os.tmpdir(), `pw-recording-${Date.now()}.ts`);

  // Launch Playwright codegen — blocks until user closes the browser
  const codegenResult = spawnSync(
    'npx',
    ['playwright', 'codegen', '--browser', 'chromium', '--output', tmpFile, targetUrl],
    { stdio: 'inherit', encoding: 'utf-8', env: { ...process.env } },
  );

  // Graceful exit if the user cancelled (e.g. Ctrl+C)
  if (codegenResult.status !== 0 && codegenResult.status !== null && !fs.existsSync(tmpFile)) {
    console.log('\n  Recording cancelled.');
    process.exit(0);
  }

  // Read the recording
  let rawRecording: string;
  try {
    rawRecording = fs.readFileSync(tmpFile, 'utf-8');
  } catch {
    console.error('\n  ✗ No recording file found. The browser may have been closed before any actions were captured.');
    process.exit(1);
  }

  // Clean up temp file
  try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }

  if (!rawRecording.trim()) {
    console.error('\n  ✗ Recording is empty — no actions were captured. Please record at least a few steps.');
    process.exit(1);
  }

  const lineCount = rawRecording.split('\n').length;
  console.log(`\n  ✓ Recording captured  (${lineCount} lines)`);

  // Optional: ask for title interactively (unless --yes or --title already set)
  let featureTitle = titleFlag;
  if (!featureTitle && !skipPrompt) {
    try {
      featureTitle = await promptForTitle('');
    } catch {
      // stdin not interactive (CI mode) — skip prompt
    }
  }

  // Extract base URL from recording
  const baseUrl = extractBaseUrlFromRecording(rawRecording);

  console.log('');
  console.log('  ↻ Calling Claude AI to convert recording to MD...');
  if (baseUrl) console.log(`     Base URL: ${baseUrl}`);

  // Convert with Claude
  const anthropic = createAnthropicClient();
  const model     = resolveModel(modelFlag ?? 'claude-opus-5');

  let mdContent: string;
  try {
    mdContent = await convertRecordingToMd(rawRecording, baseUrl, featureTitle, anthropic, model);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`\n  ✗ AI conversion failed: ${msg}`);
    if (process.env.DEBUG_RECORD) {
      console.error('  Full error:', err);
    }
    console.error('  Saving raw recording as fallback...');
    const fallbackDir = path.join(PROJECT_ROOT, 'test-results', 'recordings');
    fs.mkdirSync(fallbackDir, { recursive: true });
    const fallbackPath = path.join(fallbackDir, `recording-${Date.now()}.ts`);
    fs.writeFileSync(fallbackPath, rawRecording, 'utf-8');
    console.error(`  Raw recording saved to: ${path.relative(PROJECT_ROOT, fallbackPath)}`);
    process.exit(1);
  }

  // Determine output path
  const titleSlug = featureTitle
    ? slugify(featureTitle)
    : slugify(baseUrl.replace(/^https?:\/\/[^/]+/, '').replace(/\//g, '-') || 'recorded-flow');

  const outputPath = outputFlag
    ? path.resolve(PROJECT_ROOT, outputFlag)
    : path.resolve(PROJECT_ROOT, 'requirements', `${titleSlug}.md`);

  // Ensure output directory exists
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  // Write MD file
  fs.writeFileSync(outputPath, mdContent, 'utf-8');

  const relOutput = path.relative(PROJECT_ROOT, outputPath);

  console.log('');
  console.log('  ╔══════════════════════════════════════════════════╗');
  console.log(`  ║  ✓ MD file written: ${relOutput.padEnd(27)}║`);
  console.log('  ╚══════════════════════════════════════════════════╝');
  console.log('');
  console.log('  NEXT STEPS:');
  console.log(`  1. Review / edit the MD:   open ${relOutput}`);
  console.log(`  2. Generate + run tests:   npm run flow -- ${relOutput}`);
  console.log(`  3. Generate only:          npm run flow -- ${relOutput} --gen-only`);
  console.log('');

  // Print a preview of the first ~20 lines of the MD
  const preview = mdContent.split('\n').slice(0, 22).join('\n');
  console.log('  ── MD Preview ──────────────────────────────────────');
  for (const line of preview.split('\n')) {
    console.log(`  ${line}`);
  }
  if (mdContent.split('\n').length > 22) {
    console.log('  ...');
  }
  console.log('  ────────────────────────────────────────────────────');
  console.log('');
}

main().catch((err) => {
  console.error('\nFatal:', err instanceof Error ? err.message : err);
  process.exit(1);
});
