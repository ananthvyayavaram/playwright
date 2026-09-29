// Translates natural language phrases into structured Playwright run actions.
// No AI API needed — this is a pure deterministic string matcher.
//
// HOW TO EXTEND:
//   Add your folder names to FOLDER_PHRASES below so users can say
//   "run my feature tests" and have it map to tests/MyFeature/.
//
import fs from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';

// ─── Context ──────────────────────────────────────────────────────────────────

export interface NlContext {
  projectRoot:      string;
  testsRootDir:     string;
  generatedSpecDir: string;
  requirementsDir:  string;
}

// ─── Action types ─────────────────────────────────────────────────────────────

export type NlIntent = 'run' | 'flow' | 'heal' | 'analyze' | 'list' | 'report' | 'studio' | 'unknown';

export interface NlStudioAction { type: 'studio'; explanation: string; }

export interface NlRunAction {
  type:        'run';
  specs:       string[];
  pwFlags:     string[];
  grep?:       string;
  testEnv?:    string;
  runFailed?:  boolean;
  explanation: string;
}

export interface NlFlowAction {
  type:        'flow';
  mdPath:      string;
  options:     FlowFlags;
  explanation: string;
}

export interface NlHealAction {
  type:        'heal';
  grep?:       string;
  specs?:      string[];
  maxAttempts: number;
  headed:      boolean;
  explanation: string;
}

export interface NlAnalyzeAction  { type: 'analyze'; explanation: string; }
export interface NlListAction     { type: 'list';    explanation: string; }
export interface NlReportAction   { type: 'report';  open: boolean; explanation: string; }
export interface NlUnknownAction  { type: 'unknown'; explanation: string; suggestion: string; }

export interface FlowFlags {
  regen:   boolean;
  headed:  boolean;
  genOnly: boolean;
  runOnly: boolean;
}

export type NlAction =
  | NlRunAction | NlFlowAction | NlHealAction
  | NlAnalyzeAction | NlListAction | NlReportAction | NlStudioAction | NlUnknownAction;

// ─── Catalog types ────────────────────────────────────────────────────────────

export interface TestEntry {
  directory:      string;
  fileName:       string;
  filePath:       string;
  relPath:        string;
  describeTitles: string[];
  suiteTags:      string[];
  allTags:        string[];
  hasActiveTests: boolean;
}

export interface MdInfo {
  filePath: string;
  name:     string;
  baseUrl:  string;
  flows:    string[];
}

// ─── Test catalog scanning ────────────────────────────────────────────────────

const NOISE_TAGS = new Set(['@playwright', '@role', '@class', '@id', '@aria-label', '@data-qa-hook']);

function extractDescribeTags(content: string): string[] {
  const tags: string[] = [];
  const re = /test\.describe(?:\.\w+)?\s*\(/g;
  let m;
  while ((m = re.exec(content)) !== null) {
    const snippet  = content.slice(m.index, m.index + 600);
    const tagMatch = snippet.match(/tag:\s*\[([^\]]+)\]/);
    if (tagMatch) tags.push(...(tagMatch[1].match(/@[a-z][a-z0-9-]*/g) ?? []));
  }
  return [...new Set(tags)];
}

function extractDescribeTitles(content: string): string[] {
  const titles: string[] = [];
  const pattern = /test\.describe(?:\.\w+)?\s*\(\s*['"`]([^'"`]+)['"`]/g;
  let m;
  while ((m = pattern.exec(content)) !== null) titles.push(m[1]);
  return titles;
}

function extractAllTags(content: string): string[] {
  const matches = content.match(/@[a-z][a-z0-9-]*/g) ?? [];
  return [...new Set(matches.filter(t => !NOISE_TAGS.has(t)))];
}

function hasActiveTests(content: string): boolean {
  const lines = content.split('\n');
  let inComment = false, activeDescribe = false, activeTest = false;
  for (const line of lines) {
    const t = line.trim();
    if (t.startsWith('/*')) inComment = true;
    if (inComment) { if (t.includes('*/')) inComment = false; continue; }
    if (t.startsWith('//')) continue;
    if (/test\.describe(?:\.\w+)?\s*\(/.test(t) && !/test\.describe\.skip/.test(t)) activeDescribe = true;
    if (/^\s*test\s*\(/.test(line) && !/test\.skip\s*\(/.test(line)) activeTest = true;
  }
  return activeDescribe && activeTest;
}

export async function buildTestCatalog(testsRootDir: string): Promise<TestEntry[]> {
  if (!existsSync(testsRootDir)) return [];
  const catalog: TestEntry[] = [];
  const entries = await fs.readdir(testsRootDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dirPath = path.join(testsRootDir, entry.name);
    const files   = (await fs.readdir(dirPath)).filter(f => f.endsWith('.test.ts') || f.endsWith('.spec.ts'));
    for (const file of files) {
      const filePath = path.join(dirPath, file);
      const content  = await fs.readFile(filePath, 'utf-8').catch(() => '');
      catalog.push({
        directory:      entry.name,
        fileName:       file,
        filePath,
        relPath:        `tests/${entry.name}/${file}`,
        describeTitles: extractDescribeTitles(content),
        suiteTags:      extractDescribeTags(content),
        allTags:        extractAllTags(content),
        hasActiveTests: hasActiveTests(content),
      });
    }
  }
  return catalog;
}

export async function scanSpecs(specsDir: string): Promise<Array<{ filePath: string; stem: string; title: string }>> {
  if (!existsSync(specsDir)) return [];
  const files = (await fs.readdir(specsDir)).filter(f => f.endsWith('.spec.ts'));
  return Promise.all(files.map(async f => {
    const filePath = path.join(specsDir, f);
    const content  = await fs.readFile(filePath, 'utf-8').catch(() => '');
    const match    = content.match(/test\.describe\(['"]([^'"]+)['"]/);
    return { filePath, stem: path.basename(f, '.spec.ts'), title: match ? match[1] : f };
  }));
}

export async function scanRequirements(reqDir: string): Promise<MdInfo[]> {
  if (!existsSync(reqDir)) return [];
  const files = (await fs.readdir(reqDir)).filter(f => f.endsWith('.md') && f !== 'TEMPLATE.md');
  return Promise.all(files.map(async f => {
    const filePath = path.join(reqDir, f);
    const content  = await fs.readFile(filePath, 'utf-8').catch(() => '');
    const baseUrl  = content.match(/baseUrl:\s*(.+)/)?.[1]?.trim() ?? '';
    const flows    = [...content.matchAll(/^## (.+)/gm)].map(m => m[1].trim());
    return { filePath, name: path.basename(f, '.md'), baseUrl, flows };
  }));
}

// ─── Natural language matching ────────────────────────────────────────────────

// HOW TO ADD YOUR OWN FOLDERS:
//   Add an entry here mapping your tests/ subdirectory name to the natural
//   language phrases users would type to run it.
//   E.g. "MyFeature": ['my feature', 'feature tests', 'mf']
const FOLDER_PHRASES: Record<string, string[]> = {
  Login:     ['login', 'auth', 'authentication', 'sign in', 'signin', 'login tests', 'login page'],
  generated: ['generated', 'ai generated', 'ai-generated', 'generated spec', 'generated tests'],
  // Add more folders here as you create them:
  // Dashboard: ['dashboard', 'dash', 'home page', 'homepage'],
  // Profile:   ['profile', 'account', 'user settings'],
};

function camelToWords(s: string): string {
  return s.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
}

function detectIntent(lower: string): NlIntent {
  if (/\b(heal|fix|repair|broken|mend)\b/.test(lower))                                    return 'heal';
  if (/\b(failing\s+tests?|failed\s+tests?|tests?\s+are\s+failing)\b/.test(lower))        return 'heal';
  if (/\banalyz/.test(lower))                                                              return 'analyze';
  if (/\b(check\s+fail|what\s+went\s+wrong|why\s+did|investigate)\b/.test(lower))         return 'analyze';
  if (/\b(list|show\s+(?:all\s+)?tests?|what\s+tests?|available\s+tests?)\b/.test(lower)) return 'list';
  if (/\b(what\s+can\s+i\s+run|tell\s+me\s+what|which\s+tests?)\b/.test(lower))          return 'list';
  if (/(\b(generate|create|build|make|write)\s+(tests?|specs?|from)\b)/.test(lower))      return 'flow';
  if (/(\.md\b|\bfrom\s+requirements?\b)/.test(lower))                                    return 'flow';
  if (/\bgenerate\b/.test(lower) && !/\b(run|execute)\b/.test(lower))                     return 'flow';
  return 'run';
}

function tagToPattern(tag: string): RegExp {
  const words   = tag.slice(1).split('-');
  const escaped = words.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(`\\b${escaped.join('[\\s\\-]+')}\\b`, 'i');
}

function matchTag(lower: string, catalog: TestEntry[]): string | undefined {
  const allTags = [...new Set(catalog.flatMap(e => [...e.suiteTags, ...e.allTags]))]
    .filter(t => t.startsWith('@') && !NOISE_TAGS.has(t))
    .sort((a, b) => b.length - a.length);
  for (const tag of allTags) {
    if (tagToPattern(tag).test(lower)) return tag;
  }
  return undefined;
}

function matchSpec(lower: string, catalog: TestEntry[]): string | undefined {
  for (const entry of catalog) {
    if (!entry.hasActiveTests) continue;
    const stem = entry.fileName.replace(/\.(test|spec)\.ts$/, '').toLowerCase();
    if (lower.includes(stem)) return entry.relPath;
  }
  const seen = new Set<string>();
  for (const entry of catalog) {
    if (!entry.hasActiveTests) continue;
    const dirPath  = path.dirname(entry.relPath);
    if (seen.has(dirPath)) continue;
    const phrases  = FOLDER_PHRASES[entry.directory] ?? [];
    const dirRaw   = entry.directory.toLowerCase();
    const dirWords = camelToWords(entry.directory);
    const variants = [dirRaw, dirWords, ...phrases];
    if (variants.some(v => v.length > 2 && lower.includes(v))) {
      seen.add(dirPath);
      return dirPath;
    }
  }
  return undefined;
}

function checkRunAll(lower: string): boolean {
  return (
    /\b(all\s+tests?|everything|every\s+test|full\s+suite|whole\s+suite)\b/.test(lower) ||
    /\b(run\s+all|all\s+of\s+(them|it)|run\s+everything|test\s+everything)\b/.test(lower)
  );
}

function flagWordsToFlags(phrase: string): string[] {
  const lower = phrase.toLowerCase();
  const flags: string[] = [];
  if (/\b(headed|visible|browser|show|windowed|gui|visual|watch)\b/.test(lower)) flags.push('--headed');
  if (/\bnon[- ]?headless\b/.test(lower))                                        flags.push('--headed');
  if (/\bwith\s+(a\s+)?browser\b/.test(lower))                                   flags.push('--headed');
  if (/\b(serially?|sequential(?:ly)?|one\s+at\s+a\s+time|one\s+by\s+one)\b/.test(lower)) flags.push('--workers=1');
  if (/\b(parallel|concurrently|simultaneously|all\s+at\s+once)\b/.test(lower))  flags.push('--workers=4');
  if (/\bdebug\b/.test(lower))   { flags.push('--headed'); flags.push('--workers=1'); }
  if (/\btrace\b/.test(lower))   flags.push('--trace=on');
  return [...new Set(flags)];
}

function envFromPhrase(phrase: string): string | undefined {
  const lower = phrase.toLowerCase();
  if (/\b(staging|stg|stage)\b/.test(lower)) return 'staging';
  if (/\b(prod(uction)?|live)\b/.test(lower)) return 'prod';
  if (/\bqa\b/.test(lower))                   return 'qa';
  return undefined;
}

function isRunFailed(lower: string): boolean {
  if (/\b(only\s+failed|failed\s+only|just\s+the\s+failed)\b/.test(lower))                  return true;
  if (/\b(re[- ]?run|run|execute|retry)\s+(the\s+)?(failed|failing|broken)\b/.test(lower))  return true;
  if (/\btests?\s+(that|which)\s+(failed|are\s+failing)\b/.test(lower))                      return true;
  if (/\b(run|execute)\s+what\s+(failed|broke)\b/.test(lower))                               return true;
  return false;
}

// ─── Main export ──────────────────────────────────────────────────────────────

export async function interpretPhrase(phrase: string, context: NlContext): Promise<NlAction> {
  const lower = phrase.toLowerCase().trim();

  if (/\b(studio|ui\s+mode|open\s+ui|launch\s+ui|playwright\s+ui|test\s+ui|interactive)\b/.test(lower)) {
    return { type: 'studio', explanation: 'Opening Playwright UI Studio' };
  }

  const hasReport   = /\breports?\b/.test(lower);
  const hasTestWord = /\b(test[s]?|spec[s]?|\.md)\b/.test(lower);
  if (hasReport && !hasTestWord) {
    return { type: 'report', open: /\b(open|show|view)\b/.test(lower), explanation: 'Generating Allure report' };
  }

  const [catalog, mds] = await Promise.all([
    buildTestCatalog(context.testsRootDir),
    scanRequirements(context.requirementsDir),
  ]);

  const intent  = detectIntent(lower);
  const pwFlags = flagWordsToFlags(phrase);

  if (intent === 'analyze') return { type: 'analyze', explanation: 'Analyzing test failures' };
  if (intent === 'list')    return { type: 'list',    explanation: 'Listing available tests'  };

  if (intent === 'flow') {
    const norm     = (s: string) => s.toLowerCase().replace(/[\s\-_]+/g, '');
    const lowerNorm = norm(lower);
    const mdMatch = mds.find(m => lower.includes(m.name.toLowerCase()))
      ?? mds.find(m => lowerNorm.includes(norm(m.name)));
    if (!mdMatch) {
      return {
        type:        'unknown',
        explanation: `No requirements file matched. Available: ${mds.map(m => m.name).join(', ') || 'none'}`,
        suggestion:  'Create a .md file in requirements/ and run: pfqa generate <name>',
      };
    }
    return {
      type:   'flow',
      mdPath: mdMatch.filePath,
      options: {
        regen:   /\b(regen|regenerate|fresh|force)\b/.test(lower),
        headed:  /\bheaded\b/.test(lower),
        genOnly: /\b(gen[- ]?only|generate\s+only)\b/.test(lower),
        runOnly: /\b(run[- ]?only|just\s+run)\b/.test(lower),
      },
      explanation: `Generating tests from ${mdMatch.name}`,
    };
  }

  if (checkRunAll(lower)) {
    return { type: 'run', specs: [], pwFlags, explanation: 'Running all tests' };
  }

  const matched         = matchSpec(lower, catalog);
  const isDirectoryMatch = matched != null && !matched.endsWith('.ts');
  const grep            = isDirectoryMatch ? undefined : matchTag(lower, catalog);
  const spec            = grep ? undefined : matched;
  const runFailed       = isRunFailed(lower);

  if (runFailed) {
    return {
      type:        'run',
      specs:       [],
      pwFlags,
      runFailed:   true,
      testEnv:     envFromPhrase(phrase),
      explanation: 'Re-running only the tests that failed in the last run',
    };
  }

  if (intent === 'heal') {
    return {
      type:        'heal',
      grep:        grep ?? undefined,
      maxAttempts: 3,
      headed:      pwFlags.includes('--headed'),
      explanation: grep ? `Healing tests matching ${grep}` : 'Healing failing tests',
    };
  }

  const matchedSpecs = spec
    ? [path.isAbsolute(spec) ? spec : path.join(context.projectRoot, spec)]
        .filter(p => existsSync(p))
    : [];

  return {
    type:        'run',
    specs:       matchedSpecs,
    pwFlags,
    grep:        grep ?? undefined,
    testEnv:     envFromPhrase(phrase),
    explanation: grep  ? `Running tests matching ${grep}`
               : spec  ? `Running ${spec}`
               :         'Running all tests',
  };
}

// ─── Print helpers ────────────────────────────────────────────────────────────

export async function printAvailableTests(context: NlContext): Promise<void> {
  const [catalog, generatedSpecs, mds] = await Promise.all([
    buildTestCatalog(context.testsRootDir),
    scanSpecs(context.generatedSpecDir),
    scanRequirements(context.requirementsDir),
  ]);

  const byDir: Record<string, TestEntry[]> = {};
  for (const e of catalog) (byDir[e.directory] ??= []).push(e);

  console.log('\n─── Test Suites ─────────────────────────────────────────────────────');
  for (const [dir, entries] of Object.entries(byDir)) {
    const active   = entries.filter(e => e.hasActiveTests);
    const dirTags  = [...new Set(active.flatMap(e => e.suiteTags))];
    const phrases  = FOLDER_PHRASES[dir] ?? [camelToWords(dir)];
    console.log(`\n  ${dir}/  (${active.length}/${entries.length} files active)`);
    console.log(`    run:  pfqa "run ${phrases[0] ?? dir.toLowerCase()} tests"`);
    if (dirTags.length) {
      console.log(`    tags: ${dirTags.slice(0, 5).join(', ')}`);
    }
    for (const e of active) {
      const tags = e.suiteTags.slice(0, 3);
      console.log(`    ├─ ${e.fileName.padEnd(40)} [${tags.join(', ')}]`);
    }
  }

  if (generatedSpecs.length) {
    console.log('\n─── Generated Specs (AI-created) ────────────────────────────────────');
    for (const s of generatedSpecs) {
      console.log(`  ├─ ${s.stem.padEnd(40)} pfqa "run generated ${s.stem}"`);
    }
  }

  if (mds.length) {
    console.log('\n─── Requirements (.md) Files ────────────────────────────────────────');
    for (const m of mds) console.log(`  ${m.name}.md  →  ${m.flows.length} flow(s): ${m.flows.join(', ')}`);
  }

  console.log('\n─── Quick Examples ──────────────────────────────────────────────────');
  console.log('  pfqa "run login tests"');
  console.log('  pfqa "run login tests headed"');
  console.log('  pfqa "run login tests in staging"');
  console.log('  pfqa "run all tests"');
  console.log('  pfqa "run only failed tests"');
  console.log('  pfqa "heal failing tests"');
  console.log('  pfqa "show report"');
  console.log('  pfqa "open studio"                      # Playwright UI Studio');
  console.log('  pfqa list all tests');
  console.log('');
}
