#!/usr/bin/env tsx
/**
 * record-to-spec — Fast path: browser recording → POM + spec in 1 AI call
 *
 * Usage:
 *   npm run record:spec -- --url <app-url>
 *   npm run record:spec -- --url <app-url> --title "Create User"
 *   npm run record:spec -- --url <app-url> --direct   (no AI, instant)
 *   npm run record:spec -- --url <app-url> --yes      (skip prompts)
 */

import 'dotenv/config';
import dotenv from 'dotenv';
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import readline from 'readline/promises';
import { convertRecordingToSpec } from '../src/ai/recording-to-spec';
import { convertRecordingDirect }  from '../src/ai/recording-to-spec-direct';
import { assertAuthConfigured }    from '../src/ai/anthropic-client';
import { parseArgs, promptForUrl } from './cli-utils';

const PROJECT_ROOT = process.cwd();

async function promptForTitle(): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question('\n  Enter a title for this test (e.g. "Create User"):\n  > ');
    return answer.trim();
  } finally {
    rl.close();
  }
}

async function main() {
  const testEnv = (process.env.test_env ?? process.env.TEST_ENV ?? 'qa').toLowerCase();
  dotenv.config({ path: `helper/env/.env.${testEnv}`, override: false });

  const flags = parseArgs(process.argv.slice(2));

  const urlFlag    = flags['url']    as string | undefined;
  const titleFlag  = flags['title']  as string | undefined;
  const modelFlag  = flags['model']  as string | undefined;
  const skipPrompt = flags['yes']    === true;
  const directFlag = flags['direct'] === true;

  const defaultUrl = urlFlag ?? process.env.BASE_URL ?? '';

  let useDirect = directFlag;
  if (!useDirect && !skipPrompt) {
    const rl2 = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      console.log('');
      console.log('  Conversion mode:');
      console.log('    [1]  AI conversion    — 1 API call, ~15s, highest quality  (recommended)');
      console.log('    [2]  Direct conversion — instant, no API key required');
      console.log('');
      const modeAns = await rl2.question('  Choice [default: 1]: ');
      useDirect = modeAns.trim() === '2';
    } finally {
      rl2.close();
    }
  }

  if (!useDirect) assertAuthConfigured();

  const modeLabel = useDirect ? 'Direct · instant · no API key' : '1 AI call · ~15 seconds';

  console.log('');
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log(`║   Record → Fast Spec  ·  ${modeLabel.padEnd(30)}║`);
  console.log('╚══════════════════════════════════════════════════════════╝');

  const targetUrl = await promptForUrl(defaultUrl);

  console.log('');
  console.log('  HOW TO USE:');
  console.log('  ──────────────────────────────────────────────────────');
  console.log('  1. Perform your COMPLETE test flow in the browser.');
  console.log('     ✓ Login, navigate, click buttons, fill forms, submit.');
  console.log('  2. Close the browser when the flow is complete.');
  console.log('  3. AI converts the recording into POM + spec (1 call).');
  console.log('  4. TypeScript is checked automatically.');
  console.log('  ──────────────────────────────────────────────────────');
  console.log('');
  console.log('  Opening browser...');
  console.log('');

  const tmpFile = path.join(os.tmpdir(), `pw-recording-${Date.now()}.ts`);

  const codegenResult = spawnSync(
    'npx',
    ['playwright', 'codegen', '--browser', 'chromium', '--output', tmpFile, targetUrl],
    { stdio: 'inherit', encoding: 'utf-8', env: { ...process.env } },
  );

  if (codegenResult.status !== 0 && codegenResult.status !== null && !fs.existsSync(tmpFile)) {
    console.log('\n  Recording cancelled.');
    process.exit(0);
  }

  let rawRecording: string;
  try {
    rawRecording = fs.readFileSync(tmpFile, 'utf-8');
  } catch {
    console.error('\n  ✗ No recording file found.');
    process.exit(1);
  }

  try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }

  if (!rawRecording.trim()) {
    console.error('\n  ✗ Recording is empty — no actions captured.');
    process.exit(1);
  }

  console.log(`\n  ✓ Recording captured  (${rawRecording.split('\n').length} lines)`);

  let featureTitle = titleFlag;
  if (!featureTitle && !skipPrompt) {
    try { featureTitle = await promptForTitle() || undefined; }
    catch { /* stdin not interactive */ }
  }

  let pomFileBase:  string | undefined;
  let specFileBase: string | undefined;

  if (useDirect) {
    const pagesDir = path.join(PROJECT_ROOT, 'src', 'pages');
    const existingPoms: string[] = fs.existsSync(pagesDir)
      ? fs.readdirSync(pagesDir).filter(f => f.endsWith('.page.ts')).map(f => f.replace('.page.ts', '')).sort()
      : [];

    const rl3 = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      console.log('');
      if (existingPoms.length > 0) console.log(`  Existing POM files: ${existingPoms.join(', ')}`);
      const pomAns = await rl3.question('  POM file base name (e.g. "dashboard") [blank to auto-derive]: ');
      pomFileBase = pomAns.trim() || undefined;
      if (pomFileBase) {
        const specAns = await rl3.question(`  Spec file base name [default: ${pomFileBase}]: `);
        specFileBase = specAns.trim() || pomFileBase;
      }
    } finally {
      rl3.close();
    }
  }

  console.log('');
  if (useDirect) {
    console.log('  ↻ Converting recording → POM + spec (direct, no AI)...');
  } else {
    console.log('  ↻ Converting recording → POM + spec (1 AI call)...');
  }
  if (featureTitle) console.log(`     Feature: ${featureTitle}`);
  if (pomFileBase)  console.log(`     POM    : ${pomFileBase}.page.ts`);
  console.log('');

  let result;
  try {
    result = useDirect
      ? await convertRecordingDirect({ rawRecording, featureTitle, pomFileBase, specFileBase, projectRoot: PROJECT_ROOT })
      : await convertRecordingToSpec({ rawRecording, featureTitle, model: modelFlag, projectRoot: PROJECT_ROOT });
  } catch (err) {
    console.error(`\n  ✗ Conversion failed: ${(err as Error).message}`);
    const fallbackDir  = path.join(PROJECT_ROOT, 'test-results', 'recordings');
    const fallbackPath = path.join(fallbackDir, `recording-${Date.now()}.ts`);
    fs.mkdirSync(fallbackDir, { recursive: true });
    fs.writeFileSync(fallbackPath, rawRecording, 'utf-8');
    console.error(`  Raw recording saved to: ${path.relative(PROJECT_ROOT, fallbackPath)}`);
    process.exit(1);
  }

  const relSpec = path.relative(PROJECT_ROOT, result.specPath);
  const relPom  = path.relative(PROJECT_ROOT, result.pomPath);

  console.log('  ╔══════════════════════════════════════════════════════════╗');
  console.log(`  ║  ✓ Spec : ${relSpec.padEnd(46)}║`);
  console.log(`  ║  ✓ POM  : ${relPom.padEnd(46)}║`);
  if (result.isNewPom) console.log(`  ║  ✓ Fixture registered: ${result.fixtureName.padEnd(33)}║`);
  console.log(`  ║  TypeScript: ${(result.tsClean ? '✓ clean' : '✗ errors').padEnd(43)}║`);
  console.log('  ╚══════════════════════════════════════════════════════════╝');

  if (!result.tsClean && result.tsErrors.length) {
    console.log('');
    console.log('  TS errors:');
    for (const e of result.tsErrors.slice(0, 6)) console.log(`    ${e}`);
  }

  console.log('');
  console.log('  NEXT STEPS:');
  console.log(`  1. Review POM  : open ${relPom}`);
  console.log(`  2. Review spec : open ${relSpec}`);
  console.log(`  3. Run test    : npx playwright test ${relSpec}`);
  console.log('');
}

main().catch(err => {
  console.error('\nFatal:', err instanceof Error ? err.message : err);
  process.exit(1);
});
