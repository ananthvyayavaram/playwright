/**
 * Direct (no-AI) converter: Playwright codegen recording → POM + spec.
 *
 * Produces framework-compatible output identical in structure to the AI path —
 * same POM pattern, same spec layout, same login handling, same fixture
 * registration — without an API call.  Works offline and when no
 * ANTHROPIC_API_KEY is available.
 *
 * Method names are derived from aria labels, data-testid, placeholder, and
 * text content; they are as readable as the AI-generated ones.
 */

import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { applyPomPatch } from '../utils/pom-patcher';
import { slugify } from '../../scripts/cli-utils';
import type { RecordingToSpecOptions, RecordingToSpecResult } from './recording-to-spec';

// ── Action model ──────────────────────────────────────────────────────────────

type ActionType =
  | 'goto' | 'fill' | 'click' | 'check' | 'uncheck'
  | 'selectOption' | 'verify' | 'waitForUrl' | 'press'
  | 'hover' | 'dblclick';

interface Action {
  type:       ActionType;
  label:      string;      // human-readable label used for method naming
  locator:    string;      // this.page.xxx(...) expression
  value?:     string;      // fill value / select option / key pressed
  assertion?: string;      // toBeVisible | toContainText | etc.
  url?:       string;      // for goto actions
  rawLine:    string;
}

// ── Locator info extraction ───────────────────────────────────────────────────

function kebabToWords(s: string): string {
  return s.replace(/[-_]/g, ' ');
}

function extractLocatorInfo(expr: string): { label: string; locator: string } {
  const toPage = (e: string) =>
    e.replace(/^(?:await\s+)?page\./, 'this.page.');

  // getByRole('role', { name: '...' })
  const roleNameM = expr.match(/getByRole\(\s*['"`](\w+)['"`]\s*,\s*\{[^}]*?name\s*:\s*['"`]([^'"`]+)['"`]/);
  if (roleNameM) return { label: roleNameM[2], locator: toPage(expr) };

  // getByRole('role') — no name
  const roleM = expr.match(/getByRole\(\s*['"`](\w+)['"`]\s*\)/);
  if (roleM) return { label: roleM[1], locator: toPage(expr) };

  // getByLabel('...')
  const labelM = expr.match(/getByLabel\(\s*['"`]([^'"`]+)['"`]/);
  if (labelM) return { label: labelM[1], locator: toPage(expr) };

  // getByPlaceholder('...')
  const phM = expr.match(/getByPlaceholder\(\s*['"`]([^'"`]+)['"`]/);
  if (phM) return { label: phM[1], locator: toPage(expr) };

  // getByTestId('...')
  const testIdM = expr.match(/getByTestId\(\s*['"`]([^'"`]+)['"`]/);
  if (testIdM) return { label: kebabToWords(testIdM[1]), locator: toPage(expr) };

  // getByText('...')
  const textM = expr.match(/getByText\(\s*['"`]([^'"`]+)['"`]/);
  if (textM) return { label: textM[1], locator: toPage(expr) };

  // locator('[data-testid="..."]')
  const dtestM = expr.match(/locator\(\s*['"`][^'"`]*data-testid=['"`]([^'"`]+)['"`]/);
  if (dtestM) return { label: kebabToWords(dtestM[1]), locator: toPage(expr) };

  // locator('input[value="..."]') — common for submit buttons
  const valAttrM = expr.match(/locator\(\s*['"`][^'"`]*value=['"`]([^'"`]+)['"`]/);
  if (valAttrM) return { label: valAttrM[1], locator: toPage(expr) };

  // locator('[placeholder="..."]') or input[placeholder...]
  const inPhM = expr.match(/locator\(\s*['"`][^'"`]*placeholder=['"`]([^'"`]+)['"`]/);
  if (inPhM) {
    return {
      label: inPhM[1],
      locator: `this.page.getByPlaceholder('${inPhM[1].replace(/'/g, "\\'")}')`,
    };
  }

  // locator('[aria-label="..."]')
  const ariaM = expr.match(/locator\(\s*['"`][^'"`]*aria-label=['"`]([^'"`]+)['"`]/);
  if (ariaM) return { label: ariaM[1], locator: toPage(expr) };

  // locator('#id')
  const hashM = expr.match(/locator\(\s*['"`]#([\w-]+)/);
  if (hashM) return { label: kebabToWords(hashM[1]), locator: toPage(expr) };

  // has-text("...")
  const hasTextM = expr.match(/has-text\(\s*['"`]([^'"`]+)['"`]\)/);
  if (hasTextM) return { label: hasTextM[1], locator: toPage(expr) };

  // Fallback: any quoted string up to 40 chars
  const anyStr = expr.match(/['"`]([^'"`]{2,40})['"`]/);
  const fallbackLabel = anyStr
    ? anyStr[1].replace(/[^a-zA-Z0-9\s]/g, ' ').trim().slice(0, 30)
    : 'element';

  return { label: fallbackLabel || 'element', locator: toPage(expr) };
}

// ── Line parser ───────────────────────────────────────────────────────────────

function parseLine(line: string): Action | null {
  const t = line.trim();
  if (
    !t ||
    t.startsWith('//') ||
    t.startsWith('import ') ||
    t.startsWith('const {') ||
    t.startsWith('test(') ||
    t.startsWith('test.') ||
    t === '});' ||
    t === '})' ||
    !t.startsWith('await ')
  ) return null;

  // page.goto
  const gotoM = t.match(/^await page\.goto\(\s*['"`]([^'"`]+)['"`]/);
  if (gotoM) return { type: 'goto', url: gotoM[1], label: '', locator: '', rawLine: t };

  // waitForURL / waitForLoadState
  if (t.match(/^await page\.waitFor(?:URL|LoadState)\(/))
    return { type: 'waitForUrl', label: '', locator: '', rawLine: t };

  // waitForTimeout — skip silently
  if (t.match(/^await page\.waitForTimeout\(/)) return null;

  // expect(locator).assertion(...)
  const expectM = t.match(
    /^await expect\((.+?)\)\.(toBeVisible|toBeHidden|toContainText|toHaveText|toHaveValue|toBeChecked|toBeDisabled|toBeEnabled)\s*\(/,
  );
  if (expectM) {
    const { label, locator } = extractLocatorInfo(expectM[1]);
    return { type: 'verify', label, locator, assertion: expectM[2], rawLine: t };
  }

  // .fill(value) or .type(value)
  const fillM = t.match(/^await (.+?)\.(?:fill|type)\(\s*(['"`])([^'"`]*)\2\s*\)/);
  if (fillM) {
    const { label, locator } = extractLocatorInfo(fillM[1]);
    return { type: 'fill', label, locator, value: fillM[3], rawLine: t };
  }

  // .selectOption(value)
  const selM = t.match(/^await (.+?)\.selectOption\(\s*(['"`])([^'"`]*)\2\s*\)/);
  if (selM) {
    const { label, locator } = extractLocatorInfo(selM[1]);
    return { type: 'selectOption', label, locator, value: selM[3], rawLine: t };
  }

  // .check()
  const checkM = t.match(/^await (.+?)\.check\(\)/);
  if (checkM) {
    const { label, locator } = extractLocatorInfo(checkM[1]);
    return { type: 'check', label, locator, rawLine: t };
  }

  // .uncheck()
  const uncheckM = t.match(/^await (.+?)\.uncheck\(\)/);
  if (uncheckM) {
    const { label, locator } = extractLocatorInfo(uncheckM[1]);
    return { type: 'uncheck', label, locator, rawLine: t };
  }

  // .dblclick()
  const dblM = t.match(/^await (.+?)\.dblclick\(\)/);
  if (dblM) {
    const { label, locator } = extractLocatorInfo(dblM[1]);
    return { type: 'dblclick', label, locator, rawLine: t };
  }

  // .hover()
  const hoverM = t.match(/^await (.+?)\.hover\(\)/);
  if (hoverM) {
    const { label, locator } = extractLocatorInfo(hoverM[1]);
    return { type: 'hover', label, locator, rawLine: t };
  }

  // .press(key)
  const pressM = t.match(/^await (.+?)\.press\(\s*(['"`])([^'"`]+)\2\s*\)/);
  if (pressM) {
    const { label, locator } = extractLocatorInfo(pressM[1]);
    return { type: 'press', label: pressM[3], locator, rawLine: t };
  }

  // .click() — most generic, must be last
  const clickM = t.match(/^await (.+?)\.click\(/);
  if (clickM) {
    const { label, locator } = extractLocatorInfo(clickM[1]);
    return { type: 'click', label, locator, rawLine: t };
  }

  return null;
}

// ── Method naming ─────────────────────────────────────────────────────────────

const ARTICLES = new Set(['a', 'an', 'the', 'to', 'in', 'on', 'at', 'for', 'of', 'with']);

function toPascal(label: string): string {
  return label
    .replace(/[^a-zA-Z0-9\s]/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((w, i) => {
      const lo = w.toLowerCase();
      if (i > 0 && ARTICLES.has(lo)) return '';
      return lo.charAt(0).toUpperCase() + lo.slice(1);
    })
    .filter(Boolean)
    .join('')
    .slice(0, 50);
}

function toHuman(label: string): string {
  const words = label.replace(/[^a-zA-Z0-9\s]/g, ' ').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return label;
  return (
    words[0].charAt(0).toUpperCase() +
    words[0].slice(1).toLowerCase() +
    (words.length > 1 ? ' ' + words.slice(1).map(w => w.toLowerCase()).join(' ') : '')
  );
}

function makeMethodName(type: ActionType, label: string, used: Set<string>): string {
  const pascal = toPascal(label) || 'Element';

  const base = (() => {
    switch (type) {
      case 'fill':         return `fill${pascal}`;
      case 'click':        return `click${pascal}`;
      case 'check':        return `check${pascal}`;
      case 'uncheck':      return `uncheck${pascal}`;
      case 'selectOption': return `select${pascal}`;
      case 'verify':       return `verify${pascal}`;
      case 'hover':        return `hover${pascal}`;
      case 'dblclick':     return `doubleClick${pascal}`;
      case 'press':        return `press${pascal}`;
      case 'goto':         return 'visit';
      case 'waitForUrl':   return 'waitForNavigation';
      default:             return `perform${pascal}`;
    }
  })();

  let name = base;
  let n = 2;
  while (used.has(name)) { name = `${base}${n}`; n++; }
  used.add(name);
  return name;
}

// ── Class / file name derivation ──────────────────────────────────────────────

function classFromTitle(title: string): string {
  const pascal = title
    .replace(/[^a-zA-Z0-9\s]/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join('');
  return pascal.endsWith('Page') ? pascal : pascal + 'Page';
}

function classFromUrl(url: string): string {
  try {
    const u = new URL(url);
    const parts = u.pathname.split('/').filter(Boolean);
    const skip = new Set(['authoring', 'admin', 'api', 'v1', 'v2', 'app']);
    const kept = parts.filter(p => !skip.has(p));
    const seg = kept[kept.length - 1] ?? parts[parts.length - 1] ?? 'feature';
    // Remove query-parameter-derived suffix
    const clean = seg.split('?')[0].split('&')[0];
    const pascal = clean.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join('');
    return pascal.endsWith('Page') ? pascal : pascal + 'Page';
  } catch {
    return 'GeneratedPage';
  }
}

// ── Login sequence detection ──────────────────────────────────────────────────

interface LoginRange {
  indices: number[];
}

function detectLogin(actions: Action[]): LoginRange | null {
  const EMAIL_RE = /email|username|user\b|e-mail/i;
  const PASS_RE  = /password|passwd|pwd|pass\b/i;
  const SUBM_RE  = /log.?in|sign.?in|submit|authenticate/i;

  for (let i = 0; i < actions.length; i++) {
    const a = actions[i];
    if (a.type !== 'fill') continue;
    if (!EMAIL_RE.test(a.label) && !EMAIL_RE.test(a.value ?? '')) continue;

    for (let j = i + 1; j < Math.min(i + 5, actions.length); j++) {
      const b = actions[j];
      if (b.type !== 'fill') continue;
      if (!PASS_RE.test(b.label) && !PASS_RE.test(b.value ?? '')) continue;

      for (let k = j + 1; k < Math.min(j + 5, actions.length); k++) {
        const c = actions[k];
        if (c.type !== 'click') continue;
        if (!SUBM_RE.test(c.label)) continue;
        return { indices: [i, j, k] };
      }
    }
  }
  return null;
}

// ── POM method builder ────────────────────────────────────────────────────────

function buildMethod(action: Action, name: string): string {
  const lines: string[] = ['// [AI-generated]'];

  switch (action.type) {
    case 'fill':
      lines.push(`async ${name}(value: string): Promise<void> {`);
      lines.push(`  await ${action.locator}.fill(value);`);
      lines.push('}');
      break;

    case 'selectOption':
      lines.push(`async ${name}(option: string): Promise<void> {`);
      lines.push(`  await ${action.locator}.selectOption(option);`);
      lines.push('}');
      break;

    case 'click':
      lines.push(`async ${name}(): Promise<void> {`);
      lines.push(`  await ${action.locator}.click();`);
      lines.push('}');
      break;

    case 'dblclick':
      lines.push(`async ${name}(): Promise<void> {`);
      lines.push(`  await ${action.locator}.dblclick();`);
      lines.push('}');
      break;

    case 'hover':
      lines.push(`async ${name}(): Promise<void> {`);
      lines.push(`  await ${action.locator}.hover();`);
      lines.push('}');
      break;

    case 'check':
    case 'uncheck':
      lines.push(`async ${name}(): Promise<void> {`);
      lines.push(`  await ${action.locator}.${action.type}();`);
      lines.push('}');
      break;

    case 'verify':
      lines.push(`async ${name}(): Promise<void> {`);
      lines.push(`  await expect(${action.locator}).${action.assertion ?? 'toBeVisible'}();`);
      lines.push('}');
      break;

    case 'press':
      lines.push(`async ${name}(): Promise<void> {`);
      lines.push(`  await ${action.locator}.press('${action.value}');`);
      lines.push('}');
      break;

    case 'waitForUrl':
      lines.push(`async ${name}(): Promise<void> {`);
      lines.push(`  await this.page.waitForLoadState('domcontentloaded', { timeout: 8_000 }).catch(() => {});`);
      lines.push('}');
      break;

    default:
      lines.push(`async ${name}(): Promise<void> {`);
      lines.push(`  // TODO: implement — ${action.rawLine}`);
      lines.push('}');
  }

  return lines.join('\n');
}

// ── Spec call builder ─────────────────────────────────────────────────────────

function specCall(action: Action, methodName: string, fixtureName: string): string {
  switch (action.type) {
    case 'fill':
    case 'selectOption':
      return `await ${fixtureName}.${methodName}(${JSON.stringify(action.value ?? '')});`;
    default:
      return `await ${fixtureName}.${methodName}();`;
  }
}

// ── Step grouping ─────────────────────────────────────────────────────────────

const SUBMIT_RE = /^(save|create|add|submit|delete|remove|update|confirm|apply|publish|import|export|generate|finish|complete|done)/i;

interface Step {
  name:  string;
  lines: string[];
}

function deriveStepName(actions: Array<{ a: Action }>): string {
  for (let i = actions.length - 1; i >= 0; i--) {
    const { a } = actions[i];
    if (a.type === 'click' && SUBMIT_RE.test(a.label)) return toHuman(a.label);
  }
  const first = actions[0]?.a;
  if (first) {
    if (first.type === 'fill') return `Fill ${toHuman(first.label)} details`;
    if (first.type === 'click') return toHuman(first.label) || 'Interact with elements';
    if (first.type === 'selectOption') return `Select ${toHuman(first.label)}`;
    if (first.type === 'check') return `Enable ${toHuman(first.label)}`;
  }
  return 'Complete actions';
}

// ── Fixture helpers (local copies — avoid changing the AI converter) ──────────

function readExistingFixturesDirect(fixturesPath: string): Map<string, string> {
  const result = new Map<string, string>();
  if (!fsSync.existsSync(fixturesPath)) return result;
  const src = fsSync.readFileSync(fixturesPath, 'utf-8');
  const importRe  = /import\s+(\w+)\s+from\s+['"][^'"]+['"]/g;
  const classNames = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = importRe.exec(src)) !== null) classNames.add(m[1]);
  const fixtureRe = /(\w+):\s*async\s*\(\s*\{[^}]*\}\s*,\s*use\s*\)\s*=>/g;
  while ((m = fixtureRe.exec(src)) !== null) {
    const prop = m[1];
    const candidate = prop.charAt(0).toUpperCase() + prop.slice(1);
    if (classNames.has(candidate)) result.set(prop, candidate);
  }
  return result;
}

async function registerFixtureDirect(
  fixturesPath: string,
  pomRelImport: string,
  className:    string,
  fixtureName:  string,
): Promise<void> {
  let src = await fs.readFile(fixturesPath, 'utf-8');

  const lastImportIdx = src.lastIndexOf('\nimport ');
  const insertAfter = lastImportIdx !== -1 ? src.indexOf('\n', lastImportIdx + 1) : src.indexOf('\n');
  src = src.slice(0, insertAfter) + `\nimport ${className} from '${pomRelImport}';` + src.slice(insertAfter);

  const extendTypeIdx = src.lastIndexOf('}>({');
  if (extendTypeIdx !== -1)
    src = src.slice(0, extendTypeIdx) + `\n  ${fixtureName}: ${className};` + '\n' + src.slice(extendTypeIdx);

  const closeIdx = src.lastIndexOf('});');
  if (closeIdx !== -1)
    src = src.slice(0, closeIdx) + `\n  ${fixtureName}: async ({ page }, use) => { await use(new ${className}(page)); },` + '\n' + src.slice(closeIdx);

  await fs.writeFile(fixturesPath, src, 'utf-8');
}

// ── Main export ───────────────────────────────────────────────────────────────

export async function convertRecordingDirect(
  opts: RecordingToSpecOptions,
): Promise<RecordingToSpecResult> {
  const {
    rawRecording,
    featureTitle,
    outputDir    = 'tests/generated',
    pomDir       = 'src/pages',
    fixturesPath = 'src/fixtures/pageObjects.ts',
    projectRoot  = process.cwd(),
    baseUrlEnvVar = 'BASE_URL',
    pomFileBase: pomFileBaseOpt,
    specFileBase: specFileBaseOpt,
  } = opts;

  // ── Parse recording into actions ─────────────────────────────────────────────
  const allActions: Action[] = rawRecording
    .split('\n')
    .map(parseLine)
    .filter((a): a is Action => a !== null);

  if (!allActions.length) {
    throw new Error(
      'Direct converter: no recognised actions found in recording. ' +
      'Is this valid Playwright codegen output?',
    );
  }

  // ── Detect and mark login sequence ───────────────────────────────────────────
  const loginRange = detectLogin(allActions);
  const loginIndices = new Set(loginRange?.indices ?? []);

  // Find all gotos
  const gotos = allActions.map((a, i) => ({ a, i })).filter(({ a }) => a.type === 'goto');

  // If login was detected, mark the goto immediately before the login fill as login goto
  if (loginRange) {
    const loginStart = loginRange.indices[0];
    for (let i = loginStart - 1; i >= 0; i--) {
      if (allActions[i].type === 'goto') { loginIndices.add(i); break; }
    }
  }

  // Find the first non-login goto — this becomes visit()
  let visitUrl = '';
  let visitGotoIdx = -1;
  for (const { a, i } of gotos) {
    if (loginIndices.has(i)) continue;
    visitUrl = a.url!;
    visitGotoIdx = i;
    loginIndices.add(i); // exclude from regular action list
    break;
  }

  // Derive path portion for visit()
  let visitPath = '';
  if (visitUrl) {
    try {
      const u = new URL(visitUrl);
      visitPath = u.pathname + (u.search || '');
    } catch {
      visitPath = visitUrl;
    }
  }

  // ── Derive class / fixture names ──────────────────────────────────────────────
  let className: string;
  let fileBase: string;

  if (pomFileBaseOpt) {
    fileBase = pomFileBaseOpt;
    // If POM already exists, read the real class name from it
    const existingPom = path.resolve(projectRoot, pomDir, `${fileBase}.page.ts`);
    if (fsSync.existsSync(existingPom)) {
      const src = fsSync.readFileSync(existingPom, 'utf-8');
      const m = src.match(/export\s+default\s+class\s+(\w+)/);
      className = m ? m[1] : classFromTitle(fileBase.replace(/[-_]/g, ' '));
    } else {
      className = classFromTitle(fileBase.replace(/[-_]/g, ' '));
    }
  } else {
    className = featureTitle ? classFromTitle(featureTitle) : visitUrl ? classFromUrl(visitUrl) : 'GeneratedPage';
    fileBase  = slugify(className.replace(/Page$/, ''));
  }

  const specBase    = specFileBaseOpt ?? fileBase;
  const fixtureName = className.charAt(0).toLowerCase() + className.slice(1).replace(/Page$/, '') + 'Page';

  // ── Assign method names to non-login, non-goto actions ───────────────────────
  const used = new Set<string>(['visit']);
  const methodMap = new Map<number, string>();

  for (let i = 0; i < allActions.length; i++) {
    if (loginIndices.has(i)) continue;
    const a = allActions[i];
    if (a.type === 'goto' || a.type === 'waitForUrl') continue;
    methodMap.set(i, makeMethodName(a.type, a.label, used));
  }

  // ── Build POM methods ─────────────────────────────────────────────────────────
  const pomMethods: string[] = [];
  for (const [i, name] of methodMap) {
    pomMethods.push(buildMethod(allActions[i], name));
  }

  // ── Build spec steps ──────────────────────────────────────────────────────────
  const steps: Step[] = [];

  // Step 1: always login + navigate
  const step1Lines = [`await loginPage.loginToApplication(ENV.${baseUrlEnvVar});`];
  if (visitPath) step1Lines.push(`await ${fixtureName}.visit();`);
  steps.push({ name: 'Login and navigate', lines: step1Lines });

  // Collect remaining actions (skip login, gotos, waitForUrl)
  const remaining: Array<{ a: Action; idx: number }> = [];
  for (let i = 0; i < allActions.length; i++) {
    if (loginIndices.has(i)) continue;
    const a = allActions[i];
    if (a.type === 'goto' || a.type === 'waitForUrl') continue;
    if (!methodMap.has(i)) continue;
    remaining.push({ a, idx: i });
  }

  // Split off trailing verify actions
  let verifyStart = remaining.length;
  for (let i = remaining.length - 1; i >= 0; i--) {
    if (remaining[i].a.type === 'verify') verifyStart = i;
    else break;
  }

  const actionPart = remaining.slice(0, verifyStart);
  const verifyPart = remaining.slice(verifyStart);

  // Group action part by submit boundaries
  let currentGroup: Array<{ a: Action; idx: number }> = [];
  for (const item of actionPart) {
    currentGroup.push(item);
    if (item.a.type === 'click' && SUBMIT_RE.test(item.a.label)) {
      const lines = currentGroup.map(({ a, idx }) => specCall(a, methodMap.get(idx)!, fixtureName));
      steps.push({ name: toHuman(item.a.label), lines });
      currentGroup = [];
    }
  }
  if (currentGroup.length > 0) {
    const lines = currentGroup.map(({ a, idx }) => specCall(a, methodMap.get(idx)!, fixtureName));
    steps.push({ name: deriveStepName(currentGroup), lines });
  }

  // Verify step
  if (verifyPart.length > 0) {
    steps.push({
      name: 'Verify outcome',
      lines: verifyPart.map(({ a, idx }) => specCall(a, methodMap.get(idx)!, fixtureName)),
    });
  }

  // ── Resolve file paths ────────────────────────────────────────────────────────
  const absFixtures = path.resolve(projectRoot, fixturesPath);
  const absPomPath  = path.resolve(projectRoot, pomDir, `${fileBase}.page.ts`);
  const absSpecPath = path.resolve(projectRoot, outputDir, `${specBase}.spec.ts`);

  // Import depth from spec file back to root
  const specDepth  = outputDir.split('/').length;
  const specPrefix = '../'.repeat(specDepth);

  // ── Render POM class ──────────────────────────────────────────────────────────
  const visitMethod = visitPath
    ? [
        '// [AI-generated]',
        'async visit(): Promise<void> {',
        `  await this.page.goto(\`\${process.env.${baseUrlEnvVar}}${visitPath}\`, { waitUntil: 'domcontentloaded' });`,
        '}',
      ].join('\n')
    : null;

  const allMethodsSrc = [
    ...(visitMethod ? [visitMethod] : []),
    ...pomMethods,
  ].join('\n\n');

  const indented = allMethodsSrc.split('\n').map(l => (l ? '  ' + l : '')).join('\n');

  const fullPomCode =
    `import { Page, expect } from "@playwright/test";\n\n` +
    `export default class ${className} {\n` +
    `  constructor(public page: Page) {}\n\n` +
    `${indented}\n` +
    `}\n`;

  // ── Render spec file ──────────────────────────────────────────────────────────
  const featureTag  = slugify(featureTitle ?? className.replace(/Page$/, ''));
  const descTitle   = featureTitle ?? className.replace(/Page$/, '').replace(/([A-Z])/g, ' $1').trim();
  const fixtureArgs = ['page', 'loginPage', fixtureName].join(', ');

  const stepBlocks = steps
    .filter(s => s.lines.length > 0)
    .map(s => {
      const body = s.lines.map(l => `        ${l}`).join('\n');
      return `      await test.step('${s.name}', async () => {\n${body}\n      });`;
    })
    .join('\n\n');

  const specCode =
    `import test, { expect } from '${specPrefix}src/fixtures/pageObjects';\n` +
    `import ENV from '${specPrefix}src/utils/env';\n\n` +
    `test.describe('${descTitle}', { tag: ['@${featureTag}'] }, () => {\n` +
    `  test.use({ viewport: { width: 1920, height: 1080 } });\n\n` +
    `  test('should complete the recorded flow', { tag: ['@${featureTag}'] },\n` +
    `    async ({ ${fixtureArgs} }) => {\n` +
    `      test.setTimeout(300_000);\n\n` +
    `${stepBlocks}\n` +
    `    }\n` +
    `  );\n` +
    `});\n`;

  // ── Write files ───────────────────────────────────────────────────────────────
  await fs.mkdir(path.dirname(absPomPath),  { recursive: true });
  await fs.mkdir(path.dirname(absSpecPath), { recursive: true });

  const isNewPom = !fsSync.existsSync(absPomPath);

  if (isNewPom) {
    await fs.writeFile(absPomPath, fullPomCode, 'utf-8');
  } else {
    // Read the existing POM and extract all async method names already declared.
    // This is the upstream dedup guard: we never even pass a method to applyPomPatch
    // if it already exists, ensuring the patcher's own dedup is a belt-and-suspenders
    // safety net rather than the sole barrier.
    const existingPomSrc = fsSync.readFileSync(absPomPath, 'utf-8');
    const existingMethodNames = new Set<string>();
    for (const m of existingPomSrc.matchAll(/^[ \t]*async\s+(\w+)\s*\(/gm)) {
      existingMethodNames.add(m[1]);
    }

    // Strip the `// [AI-generated]` prefix and check the resulting method name.
    const prepareMethod = (src: string): string | null => {
      const stripped = src.replace(/^\/\/ \[AI-generated\]\n/, '');
      // Find the method name from the first async declaration line in the block.
      const nameMatch = stripped.match(/^(?:\/\/[^\n]*\n)*async\s+(\w+)\s*\(/m);
      if (nameMatch && existingMethodNames.has(nameMatch[1])) {
        console.log(`[Direct Converter] Skipping existing method: ${nameMatch[1]}`);
        return null;
      }
      return stripped;
    };

    const newMethods = [
      ...(visitMethod ? [prepareMethod(visitMethod)] : []),
      ...pomMethods.map(prepareMethod),
    ].filter((m): m is string => m !== null);

    const methodBodies = newMethods.join('\n\n');
    if (methodBodies.trim()) {
      await applyPomPatch(absPomPath, methodBodies, msg => console.log(msg));
    } else {
      console.log('[Direct Converter] All methods already exist — nothing new to add.');
    }
  }

  await fs.writeFile(absSpecPath, specCode, 'utf-8');

  // ── Register fixture in pageObjects.ts ───────────────────────────────────────
  const existingFixtures = readExistingFixturesDirect(absFixtures);
  const alreadyRegistered = [...existingFixtures.values()].includes(className);

  if (!alreadyRegistered && isNewPom && fsSync.existsSync(absFixtures)) {
    const rel = path
      .relative(path.dirname(absFixtures), absPomPath)
      .replace(/\.ts$/, '')
      .replace(/\\/g, '/');
    await registerFixtureDirect(absFixtures, rel.startsWith('.') ? rel : './' + rel, className, fixtureName);
  }

  // ── TypeScript check ──────────────────────────────────────────────────────────
  const tsCheck = spawnSync('npx', ['tsc', '--noEmit'], {
    encoding: 'utf-8',
    stdio: ['inherit', 'pipe', 'pipe'],
    cwd: projectRoot,
  });
  const tsOut    = (tsCheck.stdout ?? '') + (tsCheck.stderr ?? '');
  const tsClean  = tsCheck.status === 0 || tsCheck.status === null;
  const tsErrors = tsOut.split('\n').filter(l => l.includes('error TS'));

  return { specPath: absSpecPath, pomPath: absPomPath, className, fixtureName, isNewPom, tsClean, tsErrors };
}
