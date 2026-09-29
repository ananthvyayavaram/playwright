#!/usr/bin/env tsx
/**
 * QA Studio — the single interactive command center for the self-healing framework.
 *
 * One command handles everything:
 *   npm run studio
 *
 * Shows a live test health dashboard, then routes to any workflow action
 * via a numbered menu — no need to remember individual npm scripts.
 */

import 'dotenv/config';
import dotenv from 'dotenv';
import { spawnSync, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import readline from 'readline';

const ROOT = process.cwd();
const REQ_DIR       = path.join(ROOT, 'requirements');
const GEN_DIR       = path.join(ROOT, 'tests', 'generated');
const TESTS_DIR     = path.join(ROOT, 'tests');
const ALLURE_DIR    = path.join(ROOT, 'allure-results');
const TEST_RESULTS  = path.join(ROOT, 'test-results');

// ── ANSI colour helpers ───────────────────────────────────────────────────────

const C = {
  green:  (s: string) => `\x1b[32m${s}\x1b[0m`,
  red:    (s: string) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  cyan:   (s: string) => `\x1b[36m${s}\x1b[0m`,
  blue:   (s: string) => `\x1b[34m${s}\x1b[0m`,
  gray:   (s: string) => `\x1b[90m${s}\x1b[0m`,
  bold:   (s: string) => `\x1b[1m${s}\x1b[0m`,
  dim:    (s: string) => `\x1b[2m${s}\x1b[0m`,
  white:  (s: string) => `\x1b[97m${s}\x1b[0m`,
};

function pad(s: string, n: number) { return s.padEnd(n).slice(0, n); }
function timeAgo(ms: number): string {
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s <  60)  return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400)return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

// ── Status types ──────────────────────────────────────────────────────────────

type StatusKind = 'pass' | 'fail' | 'stale' | 'missing' | 'norun';

interface TestEntry {
  slug:        string;
  mdPath:      string;
  specPath:    string | null;
  status:      StatusKind;
  lastRunMs:   number | null;
  lastRunAgo:  string;
  testName:    string;
}

// ── Allure result scanning ────────────────────────────────────────────────────

interface AllureEntry {
  name:      string;
  status:    'passed' | 'failed' | 'broken' | 'skipped' | 'unknown';
  start:     number;
  specSlug:  string;
}

function loadAllureResults(): AllureEntry[] {
  if (!fs.existsSync(ALLURE_DIR)) return [];
  const entries: AllureEntry[] = [];
  for (const f of fs.readdirSync(ALLURE_DIR)) {
    if (!f.endsWith('-result.json')) continue;
    try {
      const data = JSON.parse(fs.readFileSync(path.join(ALLURE_DIR, f), 'utf-8'));
      const labels: Array<{ name: string; value: string }> = data.labels ?? [];
      const suite  = labels.find(l => l.name === 'suite')?.value ?? '';
      const slug   = path.basename(suite, '.spec.ts').toLowerCase();
      entries.push({
        name:     data.name ?? '',
        status:   data.status ?? 'unknown',
        start:    data.start ?? 0,
        specSlug: slug,
      });
    } catch { /* skip corrupt file */ }
  }
  return entries;
}

// ── Requirements + spec scanning ─────────────────────────────────────────────

function scanStatus(): TestEntry[] {
  const allure = loadAllureResults();

  const latestBySlug = new Map<string, AllureEntry>();
  for (const e of allure) {
    const prev = latestBySlug.get(e.specSlug);
    if (!prev || e.start > prev.start) latestBySlug.set(e.specSlug, e);
  }

  const mdFiles = fs.existsSync(REQ_DIR)
    ? fs.readdirSync(REQ_DIR).filter(f => f.endsWith('.md') && f !== 'TEMPLATE.md')
    : [];

  const entries: TestEntry[] = [];

  for (const mdFile of mdFiles.sort()) {
    const slug    = path.basename(mdFile, '.md').toLowerCase();
    const mdPath  = path.join(REQ_DIR, mdFile);
    const mdMtime = fs.statSync(mdPath).mtimeMs;

    let specPath: string | null = null;
    if (fs.existsSync(GEN_DIR)) {
      const specs = fs.readdirSync(GEN_DIR).filter(f => f.endsWith('.spec.ts'));
      specPath =
        specs.find(s => s.toLowerCase().startsWith(slug))
        ? path.join(GEN_DIR, specs.find(s => s.toLowerCase().startsWith(slug))!)
        : null;
    }

    const allureEntry = latestBySlug.get(slug)
      ?? [...latestBySlug.values()].find(e => e.specSlug.includes(slug) || slug.includes(e.specSlug));

    let status: StatusKind;
    if (!specPath) {
      status = 'missing';
    } else {
      const specMtime = fs.statSync(specPath).mtimeMs;
      const isStale   = mdMtime > specMtime;
      if (!allureEntry) {
        status = isStale ? 'stale' : 'norun';
      } else if (isStale) {
        status = 'stale';
      } else if (allureEntry.status === 'passed') {
        status = 'pass';
      } else if (allureEntry.status === 'failed' || allureEntry.status === 'broken') {
        status = 'fail';
      } else {
        status = 'norun';
      }
    }

    const lastRunMs  = allureEntry?.start ?? null;
    const lastRunAgo = lastRunMs ? timeAgo(lastRunMs) : C.dim('never');

    entries.push({
      slug, mdPath, specPath, status,
      lastRunMs, lastRunAgo,
      testName: allureEntry?.name ?? '',
    });
  }

  return entries;
}

// ── Dashboard rendering ───────────────────────────────────────────────────────

function statusBadge(s: StatusKind): string {
  switch (s) {
    case 'pass':    return C.green('✓ PASS   ');
    case 'fail':    return C.red('✗ FAIL   ');
    case 'stale':   return C.yellow('⚠ STALE  ');
    case 'missing': return C.cyan('⊘ NO SPEC');
    case 'norun':   return C.gray('─ NO RUN ');
  }
}

function statusHint(e: TestEntry): string {
  switch (e.status) {
    case 'fail':    return C.red(' → needs healing');
    case 'stale':   return C.yellow(' → MD updated, regen?');
    case 'missing': return C.cyan(' → run Generate first');
    case 'norun':   return C.gray(' → not yet run');
    default:        return '';
  }
}

function renderDashboard(entries: TestEntry[]): string {
  const pass    = entries.filter(e => e.status === 'pass').length;
  const fail    = entries.filter(e => e.status === 'fail').length;
  const stale   = entries.filter(e => e.status === 'stale').length;
  const missing = entries.filter(e => e.status === 'missing').length;
  const norun   = entries.filter(e => e.status === 'norun').length;
  const attn    = fail + stale + missing;

  const lines: string[] = [];
  lines.push('');
  lines.push(C.bold('╔══════════════════════════════════════════════════════════════════╗'));
  lines.push(C.bold('║          QA Studio  ·  Self-Healing Test Framework              ║'));
  lines.push(C.bold('╚══════════════════════════════════════════════════════════════════╝'));
  lines.push('');
  lines.push(C.bold('  TEST HEALTH OVERVIEW'));
  lines.push(C.gray('  ─────────────────────────────────────────────────────────────────'));
  lines.push(
    C.dim('  ' +
      pad('REQUIREMENTS FILE',   28) +
      pad('STATUS',    11) +
      pad('LAST RUN',   10) +
      'NOTE')
  );
  lines.push(C.gray('  ─────────────────────────────────────────────────────────────────'));

  if (entries.length === 0) {
    lines.push(C.dim('  (no requirements files found in requirements/)'));
  }

  for (const e of entries) {
    const name = pad(path.basename(e.mdPath, '.md'), 28);
    const badge = statusBadge(e.status);
    const run   = pad(e.lastRunAgo, 10);
    const hint  = statusHint(e);
    lines.push(`  ${name}${badge} ${run}${hint}`);
  }

  lines.push(C.gray('  ─────────────────────────────────────────────────────────────────'));
  const summary = [
    `${entries.length} requirement${entries.length !== 1 ? 's' : ''}`,
    C.green(`${pass} passing`),
    fail    > 0 ? C.red(`${fail} failing`)    : '',
    stale   > 0 ? C.yellow(`${stale} stale`)  : '',
    missing > 0 ? C.cyan(`${missing} missing`) : '',
    norun   > 0 ? C.gray(`${norun} not run`)  : '',
  ].filter(Boolean).join('  ·  ');
  lines.push(`  ${summary}`);

  if (attn > 0) {
    lines.push(`  ${C.yellow(`${attn} file${attn > 1 ? 's' : ''} need attention`)}`);
  }
  lines.push('');

  return lines.join('\n');
}

function renderMenu(entries: TestEntry[]): string {
  const missingEntries  = entries.filter(e => e.status === 'missing' || e.status === 'stale');

  const lines: string[] = [];
  lines.push(C.bold('  QUICK ACTIONS'));
  lines.push(C.gray('  ─────────────────────────────────────────────────────────────────'));
  lines.push(`  ${C.cyan('[1]')}  ${C.bold('Record → Fast Spec')}    — browser → POM + spec via ${C.green('AI (~15s)')} or ${C.cyan('Direct (instant, no API key)')}`);
  lines.push(`  ${C.cyan('[2]')}  ${C.bold('Generate test')}         — pick an MD file → AI browses app and writes spec${missingEntries.length > 0 ? C.yellow(` (${missingEntries.length} missing/stale)`) : ''}`);
  lines.push(`  ${C.cyan('[3]')}  ${C.bold('Run any tests')}         — pick any spec under ${C.gray('tests/')}, optional tag/grep filter, ${C.yellow('no healing')}`);
  lines.push(`  ${C.cyan('[4]')}  ${C.bold('Run generated tests')}   — pick from ${C.gray('tests/generated/')} by filename, optional tag filter, ${C.yellow('no healing')}`);
  lines.push(`  ${C.cyan('[5]')}  ${C.bold('Run all tests')}         — run all specs under ${C.gray('tests/')}, ${C.yellow('no healing')}`);
  lines.push(`  ${C.cyan('[6]')}  ${C.bold('Heal specific tests')}   — pick spec(s) to AI-heal, or heal last-failed`);
  lines.push(`  ${C.cyan('[7]')}  ${C.bold('Allure report')}         — generate ${C.green('single-file')} shareable report + open in browser`);
  lines.push(`  ${C.cyan('[q]')}  ${C.dim('Quit')}`);
  lines.push(C.gray('  ─────────────────────────────────────────────────────────────────'));
  lines.push('');

  return lines.join('\n');
}

// ── Action helpers ────────────────────────────────────────────────────────────

function run(script: string, args: string[] = []) {
  spawnSync('npx', ['tsx', script, ...args], {
    stdio: 'inherit',
    env: { ...process.env },
    cwd: ROOT,
  });
}

function askSelect(
  prompt: string,
  choices: string[],
  rl: readline.Interface,
): Promise<number | null> {
  return new Promise(resolve => {
    console.log('');
    console.log(C.bold(`  ${prompt}`));
    choices.forEach((c, i) => console.log(`  ${C.cyan(`[${i + 1}]`)}  ${c}`));
    console.log(`  ${C.cyan('[0]')}  Cancel`);
    console.log('');
    rl.question(C.bold('  Choice: '), ans => {
      const n = parseInt(ans.trim(), 10);
      if (ans.trim() === '0' || isNaN(n) || n < 1 || n > choices.length) {
        resolve(null);
      } else {
        resolve(n - 1);
      }
    });
  });
}

async function handleGenerate(entries: TestEntry[], rl: readline.Interface) {
  const targets = entries;
  if (!targets.length) {
    console.log(C.yellow('\n  No requirements files found.'));
    return;
  }
  const choices = targets.map(e => {
    const base  = path.basename(e.mdPath, '.md');
    const badge = statusBadge(e.status);
    return `${pad(base, 32)}${badge}`;
  });
  const idx = await askSelect('Which requirements file to generate?', choices, rl);
  if (idx === null) return;

  const entry  = targets[idx];
  const relMd  = path.relative(ROOT, entry.mdPath);
  const regen  = entry.specPath ? '--regen' : '';
  const genArgs = [relMd, '--gen-only', ...(regen ? [regen] : [])];

  console.log(C.cyan(`\n  Generating: ${relMd}\n`));
  run('scripts/flow.ts', genArgs);
}

function getRecordUrl(): string {
  const testEnv = (process.env.test_env ?? 'qa').toLowerCase();
  dotenv.config({ path: path.join(ROOT, `helper/env/.env.${testEnv}`), override: false });
  return process.env.BASE_URL ?? '';
}

async function handleRecordFastSpec(rl: readline.Interface) {
  const url = getRecordUrl();

  console.log('');
  console.log(C.bold('  Record → Fast Spec'));
  console.log(C.gray('  ──────────────────────────────────────────────────────────'));
  console.log(`  ${C.cyan('[1]')}  AI conversion    ${C.gray('— 1 API call, ~15s, highest quality')} ${C.green('← recommended')}`);
  console.log(`  ${C.cyan('[2]')}  Direct conversion ${C.gray('— instant, no API key required')}`);
  console.log('');

  const mode = await new Promise<'ai' | 'direct'>(resolve => {
    rl.question(C.bold('  Choice [default: 1]: '), ans => {
      resolve(ans.trim() === '2' ? 'direct' : 'ai');
    });
  });

  const modeArgs = mode === 'direct' ? ['--direct'] : [];
  const urlArgs  = url ? ['--url', url] : [];

  console.log('');
  if (mode === 'direct') {
    console.log(C.green('  ⚡ Direct mode — instant, no API key required'));
  } else {
    console.log(C.green('  ⚡ AI mode — 1 API call · ~15 seconds · minimal token usage'));
  }
  console.log(C.gray('  Recording is converted directly to POM + spec'));
  console.log(C.gray('  (no MD intermediate step, no browser exploration)'));
  console.log('');

  spawnSync('npx', ['tsx', 'scripts/record-to-spec.ts', ...urlArgs, ...modeArgs, '--yes'], {
    stdio: 'inherit', env: { ...process.env }, cwd: ROOT,
  });
}

// ── Browser mode prompt ───────────────────────────────────────────────────────

function askHeadlessMode(rl: readline.Interface): Promise<boolean> {
  return new Promise(resolve => {
    console.log('');
    console.log(C.bold('  Select browser mode:'));
    console.log(`  ${C.cyan('[1]')}  Headed   ${C.gray('(browser window visible)')} ${C.green('← default')}`);
    console.log(`  ${C.cyan('[2]')}  Headless ${C.gray('(no browser window, faster)')}`);
    console.log('');
    rl.question(C.bold('  Choice [default: headed]: '), ans => {
      resolve(ans.trim() === '2');
    });
  });
}

// ── Grep filter prompt ────────────────────────────────────────────────────────

function askGrepFilter(rl: readline.Interface): Promise<string> {
  return new Promise(resolve => {
    rl.question(
      C.dim('\n  Tag / grep filter (e.g. @smoke, @featurename) — press Enter to skip: '),
      ans => resolve(ans.trim()),
    );
  });
}

// ── Environment selection ─────────────────────────────────────────────────────

function detectEnvs(): string[] {
  const envDir = path.join(ROOT, 'helper', 'env');
  if (!fs.existsSync(envDir)) return ['qa'];
  return fs.readdirSync(envDir)
    .filter(f => f.startsWith('.env.'))
    .map(f => f.replace('.env.', ''))
    .sort();
}

async function askEnvSelect(rl: readline.Interface): Promise<string> {
  const envs = detectEnvs();
  const current = (process.env.test_env ?? process.env.TEST_ENV ?? 'qa').toLowerCase();
  return new Promise(resolve => {
    console.log('');
    console.log(C.bold('  Select environment:'));
    envs.forEach((e, i) => {
      const marker = e === current ? C.green(' ← current') : '';
      console.log(`  ${C.cyan(`[${i + 1}]`)}  ${e}${marker}`);
    });
    console.log('');
    rl.question(C.bold(`  Choice [default: ${current}]: `), ans => {
      const trimmed = ans.trim();
      if (!trimmed) return resolve(current);
      const n = parseInt(trimmed, 10);
      if (!isNaN(n) && n >= 1 && n <= envs.length) return resolve(envs[n - 1]);
      if (envs.includes(trimmed.toLowerCase())) return resolve(trimmed.toLowerCase());
      console.log(C.yellow(`  Unknown env "${trimmed}", using: ${current}`));
      resolve(current);
    });
  });
}

function buildEnvForRun(selectedEnv: string): NodeJS.ProcessEnv {
  const envFile = path.join(ROOT, 'helper', 'env', `.env.${selectedEnv}`);
  const loaded: Record<string, string> = {};
  if (fs.existsSync(envFile)) {
    const parsed = dotenv.parse(fs.readFileSync(envFile, 'utf-8'));
    Object.assign(loaded, parsed);
  }
  return { ...process.env, ...loaded, test_env: selectedEnv, TEST_ENV: selectedEnv };
}

// ── Recursive spec finder ─────────────────────────────────────────────────────

function findSpecsUnder(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) results.push(...findSpecsUnder(full));
    else if (entry.isFile() && (entry.name.endsWith('.spec.ts') || entry.name.endsWith('.test.ts'))) results.push(full);
  }
  return results.sort();
}

// ── [3] Run any tests ─────────────────────────────────────────────────────────

async function handleRunAny(rl: readline.Interface) {
  const specFiles = findSpecsUnder(TESTS_DIR);

  if (!specFiles.length) {
    console.log(C.yellow('\n  No spec files found under tests/. Generate a spec first.'));
    return;
  }

  const relSpecs = specFiles.map(p => path.relative(ROOT, p));

  const choices = [
    `Run ALL ${specFiles.length} spec${specFiles.length !== 1 ? 's' : ''}  ${C.gray('(tests/**)')}`,
    ...relSpecs,
  ];

  const idx = await askSelect(
    `Run any tests — no healing  ${C.gray('(all specs under tests/)')}`,
    choices,
    rl,
  );
  if (idx === null) return;

  const selectedEnv = await askEnvSelect(rl);
  const headless    = await askHeadlessMode(rl);
  const envVars     = { ...buildEnvForRun(selectedEnv), ...(headless ? { PW_HEADLESS: '1' } : {}) };
  const grep        = await askGrepFilter(rl);
  const grepArgs    = grep ? ['--grep', grep] : [];
  const envLabel    = C.cyan(`[${selectedEnv}]`);
  const modeLabel   = headless ? C.gray('[headless]') : C.green('[headed]');

  if (idx === 0) {
    const label = grep ? ` matching ${C.cyan(grep)}` : '';
    console.log(C.cyan(`\n  Running all ${specFiles.length} spec${specFiles.length !== 1 ? 's' : ''} under tests/${label} ${envLabel} ${modeLabel} (no healing)...\n`));
    spawnSync('npx', ['playwright', 'test', 'tests/', ...grepArgs], {
      stdio: 'inherit', env: envVars, cwd: ROOT,
    });
  } else {
    const relSpec = relSpecs[idx - 1];
    const label   = grep ? ` ${C.cyan(grep)}` : '';
    console.log(C.cyan(`\n  Running: ${path.basename(specFiles[idx - 1])}${label} ${envLabel} ${modeLabel} (no healing)...\n`));
    spawnSync('npx', ['playwright', 'test', relSpec, ...grepArgs], {
      stdio: 'inherit', env: envVars, cwd: ROOT,
    });
  }
}

// ── [4] Run generated tests ───────────────────────────────────────────────────

async function handleRunGenerated(rl: readline.Interface) {
  const specFiles = fs.existsSync(GEN_DIR)
    ? fs.readdirSync(GEN_DIR)
        .filter(f => f.endsWith('.spec.ts') || f.endsWith('.test.ts'))
        .sort()
        .map(f => path.join(GEN_DIR, f))
    : [];

  if (!specFiles.length) {
    console.log(C.yellow('\n  No spec files found in tests/generated/. Generate a spec first using [2] or [1].'));
    return;
  }

  const choices = [
    `Run ALL ${specFiles.length} generated spec${specFiles.length !== 1 ? 's' : ''}`,
    ...specFiles.map(p => path.basename(p).replace(/\.(spec|test)\.ts$/, '')),
  ];

  const idx = await askSelect(
    `Run generated tests — no healing  ${C.gray('(tests/generated/)')}`,
    choices,
    rl,
  );
  if (idx === null) return;

  const selectedEnv = await askEnvSelect(rl);
  const headless    = await askHeadlessMode(rl);
  const envVars     = { ...buildEnvForRun(selectedEnv), ...(headless ? { PW_HEADLESS: '1' } : {}) };
  const grep        = await askGrepFilter(rl);
  const grepArgs    = grep ? ['--grep', grep] : [];
  const envLabel    = C.cyan(`[${selectedEnv}]`);
  const modeLabel   = headless ? C.gray('[headless]') : C.green('[headed]');

  if (idx === 0) {
    const label = grep ? ` matching ${C.cyan(grep)}` : '';
    console.log(C.cyan(`\n  Running all ${specFiles.length} generated spec${specFiles.length !== 1 ? 's' : ''}${label} ${envLabel} ${modeLabel} (no healing)...\n`));
    spawnSync('npx', ['playwright', 'test', 'tests/generated/', ...grepArgs], {
      stdio: 'inherit', env: envVars, cwd: ROOT,
    });
  } else {
    const specPath = specFiles[idx - 1];
    const relSpec  = path.relative(ROOT, specPath);
    const label    = grep ? ` ${C.cyan(grep)}` : '';
    console.log(C.cyan(`\n  Running: ${path.basename(specPath)}${label} ${envLabel} ${modeLabel} (no healing)...\n`));
    spawnSync('npx', ['playwright', 'test', relSpec, ...grepArgs], {
      stdio: 'inherit', env: envVars, cwd: ROOT,
    });
  }
}

function handleReport() {
  if (!fs.existsSync(ALLURE_DIR) || fs.readdirSync(ALLURE_DIR).filter(f => f.endsWith('-result.json')).length === 0) {
    console.log(C.yellow('\n  No allure-results found. Run tests first.\n'));
    return;
  }

  console.log(C.cyan('\n  Generating single-file shareable report...\n'));
  spawnSync('npm', ['run', 'report:share'], { stdio: 'inherit', cwd: ROOT });

  const sharePath = path.join(ROOT, 'allure-report-share', 'index.html');
  if (!fs.existsSync(sharePath)) {
    console.log(C.red('\n  Report generation failed — allure-report-share/index.html not found.\n'));
    return;
  }

  console.log('');
  console.log(C.green(`  ✓ Report ready: allure-report-share/index.html`));
  console.log(C.dim(`    Share this single file — it contains everything, no server needed.`));
  console.log('');
  console.log(C.cyan('  Opening in browser...\n'));

  const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
  spawnSync(opener, [sharePath], { stdio: 'inherit' });
}

// ── [6] Heal specific tests ───────────────────────────────────────────────────

async function handleHealSpecific(rl: readline.Interface) {
  const specFiles = findSpecsUnder(TESTS_DIR);

  const hasLastFailed = (() => {
    const p = path.join(ROOT, 'test-results', 'last-failed.json');
    try {
      if (!fs.existsSync(p)) return false;
      const data = JSON.parse(fs.readFileSync(p, 'utf-8'));
      return (data.specs ?? []).some((s: string) => fs.existsSync(s));
    } catch { return false; }
  })();

  const choices = [
    ...(hasLastFailed ? [`${C.red('Heal last-failed tests')}  ${C.gray('(from test-results/last-failed.json)')}`] : []),
    ...specFiles.map(p => path.relative(ROOT, p)),
  ];

  if (!choices.length) {
    console.log(C.yellow('\n  No spec files found and no last-failed.json. Run tests first.\n'));
    return;
  }

  const idx = await askSelect('Which spec(s) to heal?', choices, rl);
  if (idx === null) return;

  const headless = await askHeadlessMode(rl);
  const modeLabel = headless ? C.gray('[headless]') : C.green('[headed]');

  const isLastFailed = hasLastFailed && idx === 0;
  const healArgs = isLastFailed
    ? []
    : [path.relative(ROOT, specFiles[hasLastFailed ? idx - 1 : idx])];

  const label = isLastFailed ? 'last-failed tests' : path.basename(healArgs[0]);
  console.log(C.cyan(`\n  Healing: ${label} ${modeLabel}...\n`));

  spawnSync('npx', ['tsx', 'scripts/heal.ts', ...healArgs], {
    stdio: 'inherit',
    env: { ...process.env, AUTO_HEAL: '1', ...(headless ? { PW_HEADLESS: '1' } : { PW_HEADED: '1' }) },
    cwd: ROOT,
  });
}

// ── Main interactive loop ─────────────────────────────────────────────────────

async function main() {
  const testEnv = (process.env.test_env ?? process.env.TEST_ENV ?? 'qa').toLowerCase();
  dotenv.config({ path: path.join(ROOT, `helper/env/.env.${testEnv}`), override: false });

  const rl = readline.createInterface({
    input:  process.stdin,
    output: process.stdout,
  });

  rl.on('close', () => {
    console.log(C.gray('\n  Goodbye.\n'));
    process.exit(0);
  });

  const askMenu = (entries: TestEntry[]) => new Promise<string>(resolve => {
    rl.question(C.bold('  Enter choice: '), ans => resolve(ans.trim().toLowerCase()));
  });

  let running = true;

  while (running) {
    let entries: TestEntry[] = [];
    try { entries = scanStatus(); } catch { /* non-fatal */ }

    process.stdout.write('\x1b[2J\x1b[H');
    console.log(renderDashboard(entries));
    console.log(renderMenu(entries));

    const choice = await askMenu(entries);

    switch (choice) {
      case '1':
        await handleRecordFastSpec(rl);
        break;

      case '2':
        await handleGenerate(entries, rl);
        break;

      case '3':
        await handleRunAny(rl);
        break;

      case '4':
        await handleRunGenerated(rl);
        break;

      case '5': {
        const selectedEnv = await askEnvSelect(rl);
        const headless    = await askHeadlessMode(rl);
        const envVars     = { ...buildEnvForRun(selectedEnv), ...(headless ? { PW_HEADLESS: '1' } : {}) };
        const grep        = await askGrepFilter(rl);
        const grepArgs    = grep ? ['--grep', grep] : [];
        const envLabel    = C.cyan(`[${selectedEnv}]`);
        const modeLabel   = headless ? C.gray('[headless]') : C.green('[headed]');
        const label       = grep ? ` matching ${C.cyan(grep)}` : '';
        console.log(C.cyan(`\n  Running all tests under tests/${label} ${envLabel} ${modeLabel} (no healing)...\n`));
        spawnSync('npx', ['playwright', 'test', 'tests/', ...grepArgs], {
          stdio: 'inherit', env: envVars, cwd: ROOT,
        });
        break;
      }

      case '6':
        await handleHealSpecific(rl);
        break;

      case '7':
        handleReport();
        break;

      case 'q':
      case 'quit':
      case 'exit':
        running = false;
        break;

      default:
        if (choice) {
          console.log(C.yellow(`\n  Unknown choice: "${choice}" — press Enter to continue.`));
          await new Promise(r => setTimeout(r, 1200));
        }
    }

    if (running) {
      await new Promise(r => {
        rl.question(C.dim('\n  Press Enter to return to dashboard...'), () => r(undefined));
      });
    }
  }

  rl.close();
}

main().catch(err => {
  console.error(C.red(`\nFatal: ${err instanceof Error ? err.message : err}`));
  process.exit(1);
});
