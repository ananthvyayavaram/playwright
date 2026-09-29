#!/usr/bin/env node
// Orchestrates the full generate → run → heal pipeline from a requirements .md file.
import 'dotenv/config';   // loads root .env (LiteLLM settings)
import dotenv from 'dotenv';
import { parseFrontmatter, parseFlows, buildConfig, ParsedFlow, MdConfig } from '../src/utils/md-parser';
import { generateFlow, toTag } from '../src/ai/flow-generator';
import { repairFlow }   from '../src/ai/repair-flow';
import { healMissingPomMethods, parseMissingMethods } from '../src/ai/pom-method-healer';
import { assertAuthConfigured } from '../src/ai/anthropic-client';
import { buildRequirementsContext } from '../src/utils/md-requirements-finder';
import { HealingPipeline } from '../src/healing/healing-pipeline';
import { writeHealingReport } from '../src/healing/healing-report';
import { extractBaseUrl } from '../src/healing/context-extractor';
import { spawnSync }    from 'child_process';
import fs               from 'fs/promises';
import { existsSync, watch as fsWatch } from 'fs';
import path             from 'path';

// ── Types ──────────────────────────────────────────────────────────────────────

interface GeneratedSpec {
  flow:       ParsedFlow;
  specPath:   string;
  pomPath?:   string;
  skipped:    boolean;   // true = spec already existed and --regen was not passed
}

interface TestFailure {
  specPath:         string;
  testTitle:        string;
  errorMessage:     string;
  errorStack:       string;
  errorContextPath: string | null;
}

// Playwright JSON report types
interface PwReport  { suites?: PwSuite[] }
interface PwSuite   { title?: string; file?: string; suites?: PwSuite[]; specs?: PwSpec[] }
interface PwSpec    { title?: string; ok?: boolean; file?: string; tests?: PwRun[] }
interface PwRun     { status?: string; results?: PwResult[] }
interface PwResult  {
  status?:      string;
  error?:       { message?: string; stack?: string };
  attachments?: Array<{ name?: string; path?: string }>;
}

// ── Constants ──────────────────────────────────────────────────────────────────

const PROJECT_ROOT = process.cwd();
const TEST_DIR     = path.resolve(PROJECT_ROOT, 'tests');

// ── CLI arg parser ─────────────────────────────────────────────────────────────

function parseArgs(argv: string[]): { flags: Record<string, string | boolean>; positional: string[] } {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) { positional.push(arg); continue; }
    const key  = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) { flags[key] = true; }
    else { flags[key] = next; i++; }
  }
  return { flags, positional };
}

// ── Spec filename — based on MD file name ─────────────────────────────────────
// Single flow in file → <md-name>.spec.ts (e.g. collections.spec.ts)
// Multiple flows     → <md-name>-<flow-slug>.spec.ts (e.g. collections-create-collection-flow.spec.ts)

function toSpecFileName(mdBasename: string, flowTitle: string, totalFlows: number): string {
  const mdSlug = mdBasename
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

  if (totalFlows === 1) return `${mdSlug}.spec.ts`;

  const flowSlug = flowTitle
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
  return `${mdSlug}-${flowSlug}.spec.ts`;
}

// ── Playwright runner ──────────────────────────────────────────────────────────

function runPlaywright(testArgs: string[]): { report: PwReport; exitCode: number } {
  const result = spawnSync(
    'npx',
    ['playwright', 'test', ...testArgs, '--reporter=json'],
    { encoding: 'utf-8', stdio: ['inherit', 'pipe', 'inherit'], env: { ...process.env } },
  );
  let report: PwReport = {};
  try {
    report = JSON.parse(result.stdout);
  } catch {
    const start = (result.stdout ?? '').indexOf('{');
    if (start !== -1) try { report = JSON.parse(result.stdout.slice(start)); } catch { /* ignore */ }
  }
  return { report, exitCode: result.status ?? 1 };
}

// ── Failure extractor ──────────────────────────────────────────────────────────

function resolveSpecPath(rel: string): string {
  if (!rel || path.isAbsolute(rel)) return rel;
  const a = path.resolve(TEST_DIR,     rel); if (existsSync(a)) return a;
  const b = path.resolve(PROJECT_ROOT, rel); return b;
}

function collectFailures(suite: PwSuite, parentFile = ''): TestFailure[] {
  const out: TestFailure[] = [];
  const file = suite.file ?? parentFile;
  for (const spec of suite.specs ?? []) {
    if (spec.ok === true) continue;
    const specPath = resolveSpecPath(spec.file ?? file);
    for (const run of spec.tests ?? []) {
      const res = run.results?.at(-1);
      if (!res || !['failed', 'timedOut', 'interrupted'].includes(res.status ?? '')) continue;
      out.push({
        specPath,
        testTitle:        spec.title ?? '(unknown)',
        errorMessage:     res.error?.message ?? '',
        errorStack:       res.error?.stack ?? '',
        errorContextPath: res.attachments?.find((a) => a.name === 'error-context' && a.path)?.path ?? null,
      });
    }
  }
  for (const child of suite.suites ?? []) out.push(...collectFailures(child, file));
  return out;
}

function extractFailures(report: PwReport): TestFailure[] {
  return (report.suites ?? []).flatMap((s) => collectFailures(s));
}

// ── Repair context helpers ────────────────────────────────────────────────────

function extractUrl(specContent: string): string | null {
  // extractBaseUrl prefers explicit page.goto() calls over first URL literal
  return (
    extractBaseUrl(specContent, process.env.BASE_URL ?? process.env.BASE_URL) ??
    specContent.match(/['"`](https?:\/\/[^'"`\s]+)['"`]/)?.[1] ?? null
  );
}

function pomPathsFromImports(specContent: string, specPath: string): string[] {
  const dir = path.dirname(path.resolve(specPath));
  return [...specContent.matchAll(/from\s+['"]([^'"]+)['"];?/g)]
    .map((m) => m[1])
    .filter((imp) => imp.startsWith('.') && !imp.startsWith('@'))
    .map((imp) => path.resolve(dir, imp.replace(/\.js$/, '.ts')))
    .filter((p) => existsSync(p));
}

function pomPathsFromStack(stack: string): string[] {
  return [...stack.matchAll(/\(([^)]+\.ts):\d+:\d+\)/g)]
    .map((m) => m[1])
    .filter((p) => p.includes('/src/pages/') && !p.includes('BasePage') && existsSync(p));
}

async function buildErrorOutput(f: TestFailure): Promise<string> {
  let out = f.errorMessage ? `Error: ${f.errorMessage}\n\n` : '';
  if (f.errorStack) out += `Stack trace:\n${f.errorStack}\n`;
  if (f.errorContextPath && existsSync(f.errorContextPath)) {
    const ctx = await fs.readFile(f.errorContextPath, 'utf-8');
    out += `\nPage DOM snapshot at failure:\n${ctx.slice(0, 3000)}`;
  }
  return out;
}

// ── Display helpers ───────────────────────────────────────────────────────────

function banner(text: string) {
  console.log(`\n${'─'.repeat(58)}`);
  console.log(` ${text}`);
  console.log(`${'─'.repeat(58)}`);
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  // Load the QA/staging env file so USERNAME, PASSWORD, and app URLs are available.
  // 'dotenv/config' at the top only loaded root .env (LiteLLM settings).
  // Credentials live in helper/env/.env.qa (or .env.staging, etc.).
  const testEnv = (process.env.test_env ?? process.env.TEST_ENV ?? 'qa').toLowerCase();
  dotenv.config({ path: `helper/env/.env.${testEnv}`, override: false });

  const { flags, positional } = parseArgs(process.argv.slice(2));

  if (!positional[0]) {
    console.error('Usage: npm run flow -- requirements/<file>.md [options]');
    console.error('\nOptions:');
    console.error('  --regen          Force regenerate specs');
    console.error('  --gen-only       Generate only (skip run + heal)');
    console.error('  --run-only       Run + heal only (skip generation)');
    console.error('  --headed         Headed browser');
    console.error('  --watch          Watch the MD file and auto-regen on save');
    console.error('  --max-attempts   Heal retries per test (default: 3)');
    console.error('  --model          AI model override');
    console.error('  --concurrency    Parallel generation jobs (default: 1)');
    process.exit(1);
  }

  assertAuthConfigured();

  const mdPath      = path.resolve(positional[0]);
  const forceRegen  = flags['regen']        === true;
  const genOnly     = flags['gen-only']     === true;
  const runOnly     = flags['run-only']     === true;
  const headed      = flags['headed']       === true;
  const watchMode   = flags['watch']        === true;
  const maxAttempts = parseInt((flags['max-attempts'] as string) || '3', 10);
  const concurrency = parseInt((flags['concurrency']  as string) || '2', 10);
  const modelFlag   = flags['model'] as string | undefined;

  // ── Parse MD ────────────────────────────────────────────────────────────────
  let raw: string;
  try {
    raw = await fs.readFile(mdPath, 'utf-8');
  } catch {
    console.error(`Cannot read: ${mdPath}`);
    process.exit(1);
  }

  const { config: fmConfig, body } = parseFrontmatter(raw);
  let globalConfig: MdConfig;
  try {
    globalConfig = buildConfig(fmConfig);
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }

  if (modelFlag) globalConfig.model = modelFlag;
  if (headed)    globalConfig.headed = true;

  // Fall back to env credentials when the MD file does not specify them.
  // Loaded from helper/env/.env.<env> (default: .env.qa) via dotenv at the top.
  if (!globalConfig.username) globalConfig.username = process.env.USERNAME ?? process.env.USERNAME;
  if (!globalConfig.password) globalConfig.password = process.env.PASSWORD ?? process.env.PASSWORD;

  const flows = parseFlows(body, globalConfig);
  if (!flows.length) {
    console.error('No ## sections found in the requirements file.');
    process.exit(1);
  }

  const mdBasename = path.basename(mdPath, '.md');

  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║         Self-Healing Playwright Framework               ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log(`Requirements : ${path.relative(PROJECT_ROOT, mdPath)}`);
  console.log(`Flows        : ${flows.length}`);
  console.log(`Model        : ${globalConfig.model}`);
  console.log(`Output dir   : ${globalConfig.outputDir}`);
  console.log(`Credentials  : ${globalConfig.username ? `${globalConfig.username} (from ${fmConfig.username ? 'md frontmatter' : '.env'})` : 'none — browser will need to handle auth'}`);
  if (forceRegen) console.log('Regen        : forced');

  // ── Phase 1: Generate ──────────────────────────────────────────────────────
  const generated: GeneratedSpec[] = [];

  if (!runOnly) {
    banner(`Phase 1 of 3 — Generate (${flows.length} flow${flows.length > 1 ? 's' : ''})`);

    const queue  = [...flows.entries()];
    const results: GeneratedSpec[] = [];

    async function worker() {
      while (queue.length) {
        const item = queue.shift();
        if (!item) break;
        const [i, flow] = item;

        const expectedFile = toSpecFileName(mdBasename, flow.title, flows.length);
        const expectedPath = path.resolve(PROJECT_ROOT, globalConfig.outputDir, expectedFile);

        if (!forceRegen && existsSync(expectedPath)) {
          console.log(`  [${i + 1}/${flows.length}] ↷ Skipped  "${flow.title}"  (already exists — use --regen to regenerate)`);
          results[i] = { flow, specPath: expectedPath, skipped: true };
          continue;
        }

        console.log(`  [${i + 1}/${flows.length}] ⟳ Generating  "${flow.title}"...`);
        try {
          const result = await generateFlow({
            url:             flow.url,
            flowDescription: flow.description,
            outputDir:       globalConfig.outputDir,
            headless:        !globalConfig.headed,
            model:           globalConfig.model,
            verbose:         true,
            mode:            flow.mode,
            maxTurns:        globalConfig.maxTurns,
            tag:             toTag(flow.title),
            username:        globalConfig.username,
            password:        globalConfig.password,
            outputFileName:  expectedFile,
          });
          console.log(`  [${i + 1}/${flows.length}] ✓ Generated  ${path.relative(PROJECT_ROOT, result.outputPath)}`);
          if (result.pomPath) console.log(`              POM: ${path.relative(PROJECT_ROOT, result.pomPath)}`);

          // ── Phase 1 validation: TypeScript pre-check then trial run ────────────
          // 1. Compile check first — abort trial run if TS errors are present so we
          //    don't get confusing Playwright-level failures masking compiler issues.
          console.log(`  [${i + 1}/${flows.length}] ↻ TypeScript check...`);
          const tsCheck = spawnSync('npx', ['tsc', '--noEmit'], {
            encoding: 'utf-8', stdio: ['inherit', 'pipe', 'pipe'], cwd: PROJECT_ROOT,
          });
          if (tsCheck.status !== 0 && tsCheck.status !== null) {
            const tsErrors = (tsCheck.stdout + tsCheck.stderr)
              .split('\n').filter(l => l.includes(path.relative(PROJECT_ROOT, result.outputPath)) || l.includes('error TS'));
            console.log(`  [${i + 1}/${flows.length}] ⚠ TypeScript errors in generated spec:`);
            for (const l of tsErrors.slice(0, 10)) console.log(`    ${l}`);

            // ── Auto-heal: generate missing POM methods ─────────────────────────
            const missingMethods = parseMissingMethods(tsErrors);
            if (missingMethods.length > 0 && result.pomPath) {
              console.log(`  [${i + 1}/${flows.length}] ↻ Auto-healing POM — adding ${missingMethods.length} missing method(s): ${missingMethods.join(', ')}`);
              const healResult = await healMissingPomMethods(
                result.outputPath,
                result.pomPath,
                tsErrors,
                globalConfig.model,
              );

              if (healResult.fixed) {
                console.log(`  [${i + 1}/${flows.length}] ✓ POM updated — re-checking TypeScript...`);
                // Re-run TS check after injecting the new methods
                const tsCheck2 = spawnSync('npx', ['tsc', '--noEmit'], {
                  encoding: 'utf-8', stdio: ['inherit', 'pipe', 'pipe'], cwd: PROJECT_ROOT,
                });
                if (tsCheck2.status === 0 || tsCheck2.status === null) {
                  console.log(`  [${i + 1}/${flows.length}] ✓ TypeScript clean after POM heal — running trial test...`);
                  // Fall through to the trial run below by NOT using continue here
                  results[i] = { flow, specPath: result.outputPath, pomPath: result.pomPath, skipped: false };
                  // Run trial test immediately
                  const { report: valReport2, exitCode: valExit2 } = runPlaywright([result.outputPath]);
                  if (valExit2 === 0) {
                    console.log(`  [${i + 1}/${flows.length}] ✓ Spec passes after POM heal`);
                  } else {
                    const f2 = extractFailures(valReport2);
                    if (f2.length > 0) {
                      console.log(`  [${i + 1}/${flows.length}] ↻ Spec has runtime failures — passing to full heal...`);
                    } else {
                      console.log(`  [${i + 1}/${flows.length}] ↻ Passing to full heal...`);
                    }
                  }
                  continue;
                }
                // Still TS errors — show what remains
                const remaining = (tsCheck2.stdout + tsCheck2.stderr)
                  .split('\n').filter(l => l.includes('error TS'));
                console.log(`  [${i + 1}/${flows.length}] ⚠ TS errors remain after POM heal:`);
                for (const l of remaining.slice(0, 6)) console.log(`    ${l}`);
              } else {
                console.log(`  [${i + 1}/${flows.length}] ✗ POM auto-heal failed: ${healResult.error}`);
              }
            }

            console.log(`  [${i + 1}/${flows.length}] ↻ Passing to full heal (TS errors present)...`);
            results[i] = { flow, specPath: result.outputPath, pomPath: result.pomPath, skipped: false };
            continue;
          }
          console.log(`  [${i + 1}/${flows.length}] ✓ TypeScript clean — running trial test...`);

          // 2. Trial run: run spec immediately so Phase 2 starts clean.
          // If the spec fails, attempt up to 2 quick repairs before handing off.
          const { report: valReport, exitCode: valExit } = runPlaywright([result.outputPath]);

          if (valExit === 0) {
            console.log(`  [${i + 1}/${flows.length}] ✓ Spec passes — Phase 2 will be green`);
          } else {
            let curFailures = extractFailures(valReport);
            let validated   = false;

            if (curFailures.length === 0) {
              console.log(`  [${i + 1}/${flows.length}] ↻ Passing to full heal...`);
            } else {
              for (let attempt = 1; attempt <= 2; attempt++) {
                console.log(`  [${i + 1}/${flows.length}]   ↻ Healing ${attempt}/2...`);

                const specContent = await fs.readFile(result.outputPath, 'utf-8').catch(() => '');
                const url         = extractUrl(specContent) || flow.url;
                const poms        = [...new Set([
                  ...pomPathsFromStack(curFailures[0].errorStack),
                  ...pomPathsFromImports(specContent, result.outputPath),
                ])];

                const repaired = await repairFlow({
                  specPath:       result.outputPath,
                  url,
                  errorOutput:    await buildErrorOutput(curFailures[0]),
                  pomPaths:       poms,
                  headless:       !globalConfig.headed,
                  model:          globalConfig.model,
                  verbose:        false,
                  mdRequirements: buildRequirementsContext({
                    mdPath, flowTitle: flow.title, flowDescription: flow.description, fullMdContent: raw,
                  }),
                  attemptNumber:  attempt,
                  previousErrors: [],
                }).catch(() => null);

                if (repaired?.fixed) {
                  const { exitCode: ve, report: vr } = runPlaywright([result.outputPath]);
                  if (ve === 0) {
                    console.log(`  [${i + 1}/${flows.length}] ✓ Spec passes after quick repair (attempt ${attempt})`);
                    validated = true;
                    for (const f of repaired.fixedFiles) await fs.unlink(f.backupPath).catch(() => null);
                    break;
                  }
                  const newFails = extractFailures(vr);
                  if (newFails.length) curFailures = newFails;
                }
              }

              if (!validated) {
                console.log(`  [${i + 1}/${flows.length}] ↻ Passing to full heal...`);
              }
            }
          }

          results[i] = { flow, specPath: result.outputPath, pomPath: result.pomPath, skipped: false };
        } catch (err) {
          console.error(`  [${i + 1}/${flows.length}] ✗ Failed   "${flow.title}": ${(err as Error).message}`);
          results[i] = { flow, specPath: expectedPath, skipped: false };
        }
      }
    }

    const workers = Array.from({ length: Math.min(concurrency, flows.length) }, worker);
    await Promise.all(workers);
    generated.push(...results.filter(Boolean));

    // ── Generation Quality Report ─────────────────────────────────────────────
    banner('Generation Quality Report');
    const tsCheck2 = spawnSync('npx', ['tsc', '--noEmit'], {
      encoding: 'utf-8', stdio: ['inherit', 'pipe', 'pipe'], cwd: PROJECT_ROOT,
    });
    const tsClean = tsCheck2.status === 0 || tsCheck2.status === null;
    console.log(`  TypeScript : ${tsClean ? '✓ clean' : '✗ errors present'}`);

    for (const g of results.filter(Boolean)) {
      if (g.skipped) {
        console.log(`  ↷ ${path.relative(PROJECT_ROOT, g.specPath)}  (skipped)`);
        continue;
      }
      const specExists = existsSync(g.specPath);
      const pomRelPath = g.pomPath ? path.relative(PROJECT_ROOT, g.pomPath) : '(none)';
      console.log(`  ✓ spec  : ${path.relative(PROJECT_ROOT, g.specPath)}${specExists ? '' : '  ← MISSING'}`);
      console.log(`    POM   : ${pomRelPath}`);

      // Check if all methods the spec calls actually exist on the page class
      if (specExists && g.pomPath && existsSync(g.pomPath)) {
        const specSrc = await fs.readFile(g.specPath, 'utf-8').catch(() => '');
        const pomSrc  = await fs.readFile(g.pomPath,  'utf-8').catch(() => '');
        const callRe  = /\.\s*([a-zA-Z_]\w*)\s*\(/g;
        const definedMethods = new Set([...pomSrc.matchAll(/async\s+(\w+)\s*\(/g)].map(m => m[1]));
        const calledMethods  = [...specSrc.matchAll(callRe)].map(m => m[1]);
        const missing        = calledMethods.filter(m => !definedMethods.has(m) && m !== 'then' && m !== 'catch' && m.length > 2);
        const uniqueMissing  = [...new Set(missing)];
        if (uniqueMissing.length > 0) {
          console.log(`    WARN  : spec calls methods not in POM: ${uniqueMissing.slice(0, 5).join(', ')}`);
        } else {
          console.log(`    Methods: ✓ all referenced methods found in POM`);
        }
      }
    }
    if (!tsClean) {
      const errLines = (tsCheck2.stdout + tsCheck2.stderr).split('\n')
        .filter(l => l.includes('error TS')).slice(0, 8);
      for (const l of errLines) console.log(`    ${l}`);
    }
    console.log('');
  }

  if (genOnly) {
    banner('Generation complete');
    console.log('\n  Run tests with:');
    console.log(`  npx playwright test ${globalConfig.outputDir}`);
    return;
  }

  // Collect spec paths to run (generated + any pre-existing from --run-only)
  let specPaths: string[];

  if (runOnly) {
    // Derive spec paths from the MD flows without generating
    specPaths = flows
      .map((f) => {
        const file = toSpecFileName(mdBasename, f.title, flows.length);
        return path.resolve(PROJECT_ROOT, globalConfig.outputDir, file);
      })
      .filter(existsSync);

    if (!specPaths.length) {
      console.error('\nNo matching spec files found. Run without --run-only to generate first.');
      process.exit(1);
    }
  } else {
    specPaths = generated.map((g) => g.specPath).filter(existsSync);
  }

  // ── Phase 2: Run ───────────────────────────────────────────────────────────
  banner(`Phase 2 of 3 — Run (${specPaths.length} spec${specPaths.length > 1 ? 's' : ''})`);

  let { report, exitCode } = runPlaywright(specPaths);

  if (exitCode === 0) {
    banner('All done');
    console.log('\n  ✓ All tests passed.\n');
    return;
  }

  let failures = extractFailures(report);

  if (!failures.length) {
    console.log('\n⚠ Tests exited non-zero but no parseable failures found (config/compile error?).');
    process.exit(exitCode);
  }

  // ── Phase 3: Auto-Heal ─────────────────────────────────────────────────────
  banner(`Phase 3 of 3 — Auto-Heal (${failures.length} failure${failures.length > 1 ? 's' : ''})`);

  // Build MD requirements context for every spec being healed.
  // Works for both normal runs (use generated[]) and --run-only (derive from flows[]).
  const flowsBySpec = new Map<string, { flow: ParsedFlow; mdContent: string }>();

  const flowSourceList: Array<{ flow: ParsedFlow; specPath: string }> = runOnly
    ? flows.map((flow) => ({
        flow,
        specPath: path.resolve(PROJECT_ROOT, globalConfig.outputDir, toSpecFileName(mdBasename, flow.title, flows.length)),
      })).filter(({ specPath }) => existsSync(specPath))
    : generated.filter(g => g.specPath).map(g => ({ flow: g.flow, specPath: g.specPath }));

  for (const { flow, specPath } of flowSourceList) {
    const mdContent = buildRequirementsContext({
      mdPath:          mdPath,
      flowTitle:       flow.title,
      flowDescription: flow.description,
      fullMdContent:   raw,
    });
    flowsBySpec.set(specPath, { flow, mdContent });
  }

  const healSummary: Array<{ spec: string; passed: boolean; filesFixed: string[]; strategies: string[] }> = [];
  const failingSpecs = [...new Set(failures.map((f) => f.specPath))].filter(Boolean);
  const pipeline     = new HealingPipeline({}, true);

  for (const specPath of failingSpecs) {
    const specFailures = failures.filter((f) => f.specPath === specPath);
    const relSpec      = path.relative(PROJECT_ROOT, specPath);
    const mdCtx        = flowsBySpec.get(specPath);

    console.log(`\n  ═══ Healing: ${relSpec} ═══`);
    console.log(`  Test: ${specFailures.map((f) => `"${f.testTitle}"`).join(', ')}`);
    if (mdCtx) console.log(`  MD:   ${mdCtx.flow.title}`);

    let passed          = false;
    const allFixed:     string[]   = [];
    const strategies:   string[]   = [];
    const prevErrors:   string[]   = [];

    // Current error — updated to the latest error after each failed verification
    let currentError = await buildErrorOutput(specFailures.find(f => f.errorStack) ?? specFailures[0]);

    // ── Tier 1: Fast deterministic / low-token healing ─────────────────────
    {
      let specContent = '';
      try { specContent = await fs.readFile(specPath, 'utf-8'); } catch { /* ignore */ }

      const pomPaths = [...new Set([
        ...pomPathsFromStack(specFailures[0].errorStack),
        ...pomPathsFromImports(specContent, specPath),
      ])];
      const url = extractUrl(specContent);

      const primary    = specFailures[0];
      const fastResult = await pipeline.heal({
        testTitle:     primary.testTitle,
        specPath,
        pomPaths,
        errorMessage:  primary.errorMessage,
        stackTrace:    primary.errorStack,
        currentUrl:    url ?? '',
        mdDescription: mdCtx?.mdContent,
        attemptNumber: 1,
      }).catch(err => {
        console.error(`  [Fast-heal error] ${err instanceof Error ? err.message : err}`);
        return null;
      });

      if (fastResult?.success) {
        const healedFile = fastResult.stepInfo?.filePath ?? specPath;
        allFixed.push(path.relative(PROJECT_ROOT, healedFile));
        strategies.push(`fast:${fastResult.source ?? 'DETERMINISTIC'}`);
        console.log(`  ✓ Fast-healed [${fastResult.source}] confidence=${((fastResult.confidence ?? 0) * 100).toFixed(0)}% tokens=${fastResult.tokensUsed}`);

        console.log(`  ↻ Verifying...`);
        const { exitCode: verifyExit } = runPlaywright([specPath]);
        if (verifyExit === 0) {
          console.log(`  ✓ Test passes.`);
          passed = true;
          healSummary.push({ spec: relSpec, passed: true, filesFixed: allFixed, strategies });
          continue;
        }
        // Restore backup and fall through to Tier 2
        console.log(`  ✗ Verification failed — escalating to Tier 2`);
        if (fastResult.stepInfo?.filePath) {
          const bak = `${fastResult.stepInfo.filePath}.bak`;
          if (existsSync(bak)) {
            const original = await fs.readFile(bak, 'utf-8').catch(() => null);
            if (original) await fs.writeFile(fastResult.stepInfo.filePath, original, 'utf-8').catch(() => null);
          }
        }
      } else if (fastResult && !fastResult.fallbackRequired) {
        // Pipeline detected a product defect or non-automatable failure
        console.log(`  ⊘ Not auto-healing: ${fastResult.error ?? fastResult.failureCategory}`);
        healSummary.push({ spec: relSpec, passed: false, filesFixed: [], strategies: [] });
        continue;
      }
    }
    // ── Tier 2: Full repair agent (existing behaviour) ─────────────────────

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const stratLabel = ['locator-fix', 'flow-analysis', 'full-regeneration'][Math.min(attempt - 1, 2)];
      console.log(`\n  ─── Attempt ${attempt}/${maxAttempts} [${stratLabel}] ───`);

      let specContent = '';
      try { specContent = await fs.readFile(specPath, 'utf-8'); }
      catch { console.error(`  ✗ Cannot read spec: ${specPath}`); break; }

      const url      = extractUrl(specContent);
      if (!url) { console.error('  ✗ No URL found in spec.'); break; }

      const pomPaths = [...new Set([
        ...pomPathsFromStack(specFailures[0].errorStack),
        ...pomPathsFromImports(specContent, specPath),
      ])];

      console.log(`    URL : ${url}`);
      console.log(`    POM : ${pomPaths.length ? pomPaths.map(p => path.relative(PROJECT_ROOT, p)).join(', ') : '(none)'}`);

      const result = await repairFlow({
        specPath,
        url,
        errorOutput:    currentError,
        pomPaths,
        headless:       !headed,
        model:          globalConfig.model,
        verbose:        true,
        mdRequirements: mdCtx?.mdContent,
        attemptNumber:  attempt,
        previousErrors: [...prevErrors],
      });

      if (!result.fixed) {
        console.log(`    ✗ No fix produced.${attempt < maxAttempts ? ' Escalating...' : ''}`);
        prevErrors.push(currentError);
        continue;
      }

      const fixed = result.fixedFiles.map(f => path.relative(PROJECT_ROOT, f.path));
      allFixed.push(...fixed);
      strategies.push(result.strategyUsed);
      console.log(`    ✓ Fixed [${result.strategyUsed}]: ${fixed.join(', ')}`);

      console.log(`    ↻ Verifying...`);
      const { exitCode: verifyExit, report: vReport } = runPlaywright([specPath, '--reporter=json']);

      if (verifyExit === 0) {
        console.log(`    ✓ Test passes after ${attempt} attempt(s)!`);
        passed = true;
        // Clean up backup files — no longer needed after a successful fix
        for (const f of result.fixedFiles) {
          await fs.unlink(f.backupPath).catch(() => null);
        }
        break;
      }

      // Capture the NEW error for the next attempt — don't reuse the original
      const newFails = extractFailures(vReport).filter(f => f.specPath === specPath);
      if (newFails.length) {
        const newErr = await buildErrorOutput(newFails[0]);
        currentError = newErr;
        console.log(`    ✗ Still failing. New error: ${newFails[0].errorMessage.split('\n')[0].slice(0, 120)}`);
        specFailures.splice(0, specFailures.length, ...newFails);
      } else {
        console.log(`    ✗ Still failing.${attempt < maxAttempts ? ' Escalating...' : ''}`);
      }
      prevErrors.push(currentError);
    }

    healSummary.push({ spec: relSpec, passed, filesFixed: allFixed, strategies });
  }

  // Write healing report if the fast-path pipeline was used
  const pipelineReports = pipeline.getReports();
  if (pipelineReports.length > 0) writeHealingReport(pipelineReports);

  // ── Final report ───────────────────────────────────────────────────────────
  banner('Final Report');
  let allPassed = true;
  for (const r of healSummary) {
    const icon = r.passed ? '✓' : '✗';
    console.log(`\n  ${icon} ${path.basename(r.spec)}`);
    if (r.strategies.length) console.log(`    Strategies: ${r.strategies.join(' → ')}`);
    if (r.filesFixed.length) r.filesFixed.forEach(f => console.log(`    Fixed: ${f}`));
    if (!r.passed) allPassed = false;
  }

  if (allPassed) {
    console.log('\n  ✓ All tests pass (some were auto-healed).\n');
  } else {
    console.log('\n  ✗ Some tests could not be healed. Run with --headed to debug.\n');
    if (!watchMode) process.exit(1);
  }

  // ── Watch mode ─────────────────────────────────────────────────────────────
  if (watchMode) {
    banner('Watch mode — waiting for changes (Ctrl+C to stop)');
    console.log(`  Watching: ${path.relative(PROJECT_ROOT, mdPath)}`);
    console.log('  Save the MD file to trigger automatic regeneration.\n');

    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    fsWatch(mdPath, () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(async () => {
        console.log(`\n  ⚡ MD file changed — regenerating + running...\n`);
        try {
          await main();
        } catch (e) {
          console.error(`  ✗ Error during re-run: ${(e as Error).message}`);
        }
      }, 600);
    });

    // Keep the process alive until Ctrl+C
    await new Promise<void>(resolve => process.once('SIGINT', resolve));
    console.log('\n  Watch stopped.\n');
  }
}

main().catch((err) => {
  console.error('\nFatal:', err instanceof Error ? err.message : err);
  process.exit(1);
});
