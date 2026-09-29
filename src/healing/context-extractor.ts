/**
 * Extracts the minimal context needed for healing from a failing test's
 * error message, stack trace, and TypeScript source files.
 *
 * Returns enough information to understand WHAT was being attempted
 * and WHERE in the code to patch — without reading whole files.
 */
import fs from 'fs';
import path from 'path';
import type { FailedStepInfo } from './types';

// Two-level property access: this.group.key  (most common POM pattern)
const PROPERTY_GROUP_REF_RE = /\.locator\(\s*this\.(\w+)\.(\w+)\s*\)/;

// Playwright error-message patterns that expose the raw locator string:
//   waiting for locator('xpath=...')
//   locator('...').click(): Timeout
//   locator.waitFor: Timeout ... waiting for locator('...')
const ERROR_LOCATOR_RE = /(?:waiting\s+for\s+)?(?:expect\()?locator\(\s*['"`](.*?)['"`]\s*\)/i;

// Patterns that identify the failing call on a source line.
// Order matters: more specific (inline string) before generic.
const LOCATOR_LINE_PATTERNS: Array<{
  re: RegExp;
  method: string;
  selector: (m: RegExpMatchArray) => string;
  call: (m: RegExpMatchArray) => string;
}> = [
  {
    re: /\.locator\(\s*(['"`])((?:\\\1|(?!\1).)*)\1\s*\)/,
    method: 'locator',
    selector: (m) => m[2],
    call: (m) => `locator(${m[1]}${m[2]}${m[1]})`,
  },
  {
    re: /\.getByTestId\(\s*(['"`])((?:\\\1|(?!\1).)*)\1\s*\)/,
    method: 'getByTestId',
    selector: (m) => `[data-testid="${m[2]}"]`,
    call: (m) => `getByTestId(${m[1]}${m[2]}${m[1]})`,
  },
  {
    re: /\.getByRole\(\s*(['"`])((?:\\\1|(?!\1).)*)\1([^)]*)\)/,
    method: 'getByRole',
    selector: (m) => `[role="${m[2]}"]`,
    call: (m) => `getByRole(${m[1]}${m[2]}${m[1]}${m[3]})`,
  },
  {
    re: /\.getByLabel\(\s*(['"`])((?:\\\1|(?!\1).)*)\1\s*\)/,
    method: 'getByLabel',
    selector: (m) => `[aria-label="${m[2]}"]`,
    call: (m) => `getByLabel(${m[1]}${m[2]}${m[1]})`,
  },
  {
    re: /\.getByText\(\s*(['"`])((?:\\\1|(?!\1).)*)\1\s*\)/,
    method: 'getByText',
    selector: (m) => `:text("${m[2]}")`,
    call: (m) => `getByText(${m[1]}${m[2]}${m[1]})`,
  },
  {
    re: /\.getByPlaceholder\(\s*(['"`])((?:\\\1|(?!\1).)*)\1\s*\)/,
    method: 'getByPlaceholder',
    selector: (m) => `[placeholder="${m[2]}"]`,
    call: (m) => `getByPlaceholder(${m[1]}${m[2]}${m[1]})`,
  },
  {
    re: /\.waitForSelector\(\s*(['"`])((?:\\\1|(?!\1).)*)\1\s*\)/,
    method: 'waitForSelector',
    selector: (m) => m[2],
    call: (m) => `waitForSelector(${m[1]}${m[2]}${m[1]})`,
  },
];

// Detects the Playwright action method chained after the locator.
const ACTION_RE = /\.(click|fill|check|uncheck|hover|select|type|press|dblclick|focus|blur|tap)\s*\(/;

// Detects a property-based locator: this.someProperty
const PROPERTY_REF_RE = /\.locator\(\s*this\.(\w+)\s*\)/;

// Extracts the property value definition: private foo = '...';
const PROPERTY_DEF_RE = (name: string) =>
  new RegExp(`(?:private|protected|public|readonly|\\s)\\s+${name}\\s*=\\s*(['"\`])(.*?)\\1`);

/**
 * Parse a Playwright / Node.js stack trace line to extract file + line number.
 * Handles both "at func (file:line:col)" and "at file:line:col" forms.
 */
function parseStackFrame(frame: string): { filePath: string; lineNumber: number } | null {
  const m = frame.match(/\(([^)]+\.ts):(\d+):\d+\)/) ?? frame.match(/at\s+([^:]+\.ts):(\d+):\d+/);
  if (!m) return null;
  return { filePath: m[1], lineNumber: parseInt(m[2], 10) };
}

/**
 * Convert a selector/method name into meaningful semantic tokens.
 * '#create-playlist-btn' → ['create', 'playlist', 'btn']
 * 'clickLoginButton' → ['click', 'login', 'button']
 */
function tokenize(input: string): string[] {
  return input
    .replace(/[#.\[\]'"={}()]/g, ' ')
    .replace(/[-_]/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .split(/\s+/)
    .map(t => t.toLowerCase())
    .filter(t => t.length > 1 && !['the', 'and', 'for', 'btn', 'button', 'input', 'el', 'elem'].includes(t));
}

/** Map short abbreviations to full words for better intent matching */
const ABBREV: Record<string, string> = {
  btn: 'button', lnk: 'link', inp: 'input', sel: 'select',
  chk: 'checkbox', txt: 'text', nav: 'navigation', hdr: 'header',
  ftr: 'footer', img: 'image', dlg: 'dialog', mdl: 'modal',
  drp: 'dropdown', tgl: 'toggle', swt: 'switch', lbl: 'label',
};

function expandAbbreviations(tokens: string[]): string[] {
  return tokens.map(t => ABBREV[t] ?? t);
}

/** Build a human-readable intent phrase from tokens: ['login', 'button'] → 'Login button' */
function buildIntentPhrase(tokens: string[]): string {
  if (tokens.length === 0) return 'unknown element';
  return tokens.map((t, i) => (i === 0 ? t.charAt(0).toUpperCase() + t.slice(1) : t)).join(' ');
}

/** Derive intent tokens from: selector string + method name + surrounding comment */
function deriveIntent(
  selector: string,
  locatorMethod: string,
  methodName?: string,
  surroundingCode?: string,
): { tokens: string[]; phrase: string } {
  const raw: string[] = [];

  // 1. Tokens from the method name on the POM (most specific)
  if (methodName) raw.push(...tokenize(methodName).filter(t => t !== 'click' && t !== 'fill' && t !== 'get' && t !== 'set'));

  // 2. Tokens from the selector
  raw.push(...tokenize(selector));

  // 3. Tokens from single-line comment above the call
  if (surroundingCode) {
    const commentMatch = surroundingCode.match(/\/\/\s*(.+)/);
    if (commentMatch) raw.push(...tokenize(commentMatch[1]));
  }

  const deduped = [...new Set(expandAbbreviations(raw))].slice(0, 6);
  return { tokens: deduped, phrase: buildIntentPhrase(deduped) };
}

/**
 * Attempt to find the failing locator in the POM's property definitions.
 * This handles the pattern:
 *   private loginBtn = '#login-btn';
 *   await this.page.locator(this.loginBtn).click();
 */
function resolvePropertyLocator(
  fileContent: string,
  propertyName: string,
): string | null {
  const m = fileContent.match(PROPERTY_DEF_RE(propertyName));
  return m ? m[2] : null;
}

/**
 * Resolve a grouped object-property locator:
 *   public contentPlaylistCreateModal = { createExperienceButton: 'xpath=...' };
 *   → resolveGroupPropertyLocator(content, 'contentPlaylistCreateModal', 'createExperienceButton')
 *   → 'xpath=...'
 */
function resolveGroupPropertyLocator(
  fileContent: string,
  groupName: string,
  propKey: string,
): string | null {
  // Find the object group body: public groupName = { ... }
  const groupRe = new RegExp(`public\\s+${groupName}\\s*=\\s*\\{([^}]{0,10000})\\}`, 's');
  const gm = fileContent.match(groupRe);
  if (!gm) return null;

  // Within the group body, find: propKey: 'value'
  const propRe = new RegExp(`\\b${propKey}\\s*:\\s*(['"\`])((?:\\\\.|(?!\\1).)*)\\1`);
  const pm = gm[1].match(propRe);
  return pm ? pm[2] : null;
}

/**
 * Extract the raw locator string from a Playwright error message.
 * Playwright always includes the locator in error messages like:
 *   "locator('xpath=...').click(): Timeout"
 *   "waiting for locator('xpath=...')"
 *   "waiting for expect(locator('...')).toBeVisible()"
 */
function extractLocatorFromError(errorMessage: string): string | null {
  const m = errorMessage.match(ERROR_LOCATOR_RE);
  return m ? m[1] : null;
}

/**
 * Search POM files for a line that contains the given locator string as a value.
 * Returns the file path and the line number (1-based) of the property that holds it.
 * This is used as a fallback when the failing source line itself has no locator call.
 */
function findLocatorInPomFiles(
  locatorStr: string,
  pomPaths: string[],
  specPath: string,
): { filePath: string; lineNumber: number; methodName?: string; groupName?: string; propKey?: string } | null {
  const allPomCandidates = [...pomPaths];
  // Also look in src/pages/ sibling of specPath
  const pagesDir = path.resolve(path.dirname(specPath), '../../src/pages');
  if (!allPomCandidates.some(p => p.includes('/src/pages/')) && fs.existsSync(pagesDir)) {
    try {
      const files = fs.readdirSync(pagesDir)
        .filter(f => f.endsWith('.ts') && !f.includes('BasePage'))
        .map(f => path.join(pagesDir, f));
      allPomCandidates.push(...files);
    } catch { /* ignore */ }
  }

  // Escape the locator string for regex matching
  const escaped = locatorStr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  for (const pomPath of [...new Set(allPomCandidates)]) {
    let content: string;
    try { content = fs.readFileSync(pomPath, 'utf-8'); }
    catch { continue; }

    // Find the line containing this locator value
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].includes(locatorStr)) continue;

      // Extract property key: `propKey: 'locator'` or `propKey = 'locator'`
      const propKeyMatch = lines[i].match(/(\w+)\s*[=:]\s*['"`]/);
      const propKey = propKeyMatch ? propKeyMatch[1] : undefined;

      // Determine group name if this is inside an object literal
      let groupName: string | undefined;
      for (let j = i; j >= 0; j--) {
        // Look for `public groupName = {` above this line
        const gm = lines[j].match(/public\s+(\w+)\s*=\s*\{/);
        if (gm) { groupName = gm[1]; break; }
        // Stop if we hit a method signature or class declaration
        if (/^(?:async\s+\w|export\s+default\s+class|^\})/.test(lines[j].trim())) break;
      }

      const methodName = findEnclosingMethodName(lines, i);
      return { filePath: pomPath, lineNumber: i + 1, methodName, groupName, propKey };
    }
  }

  return null;
}

/**
 * Identify which source frame to focus on: prefer POM files (src/pages/) over spec files.
 * Falls back to spec if no POM frame is found.
 */
function selectTargetFrame(
  stackTrace: string,
  pomPaths: string[],
  specPath: string,
): { filePath: string; lineNumber: number } | null {
  const frames = stackTrace.split('\n').map(l => l.trim()).filter(Boolean);

  // First: look for a POM path in the stack
  for (const frame of frames) {
    const parsed = parseStackFrame(frame);
    if (!parsed) continue;
    const absPath = parsed.filePath;
    if (pomPaths.some(p => path.resolve(p) === path.resolve(absPath))) return parsed;
    if (absPath.includes('/src/pages/') && !absPath.includes('BasePage')) return parsed;
  }

  // Second: fall back to the spec file itself
  for (const frame of frames) {
    const parsed = parseStackFrame(frame);
    if (!parsed) continue;
    if (path.resolve(parsed.filePath) === path.resolve(specPath)) return parsed;
  }

  // Last: any .ts frame in the project
  for (const frame of frames) {
    const parsed = parseStackFrame(frame);
    if (parsed && parsed.filePath.endsWith('.ts') && !parsed.filePath.includes('node_modules')) {
      return parsed;
    }
  }

  return null;
}

/** Extract the method name that contains the failing line (searches upward for 'async methodName'). */
function findEnclosingMethodName(lines: string[], failingLineIndex: number): string | undefined {
  for (let i = failingLineIndex; i >= 0; i--) {
    const m = lines[i].match(/async\s+(\w+)\s*\(/);
    if (m) return m[1];
  }
  return undefined;
}

/**
 * Core extraction: given a file path and a line number, extract the locator call,
 * the selector string, the action, and surrounding context.
 */
function extractFromLine(
  fileContent: string,
  lineNumber: number,
): {
  locatorCall: string;
  locatorMethod: string;
  locator: string;
  action: string;
  propertyName?: string;
  groupName?: string;
  surroundingCode: string;
} | null {
  const lines = fileContent.split('\n');
  const idx = lineNumber - 1; // 0-based
  if (idx < 0 || idx >= lines.length) return null;

  const line = lines[idx];

  // Check for two-level group access: this.page.locator(this.group.key)
  const groupRefMatch = line.match(PROPERTY_GROUP_REF_RE);
  let groupName: string | undefined;

  if (groupRefMatch) {
    const [, grp, key] = groupRefMatch;
    const resolved = resolveGroupPropertyLocator(fileContent, grp, key);
    if (resolved) {
      groupName  = grp;
      const action = line.match(ACTION_RE)?.[1] ?? 'unknown';
      const surrounding = lines
        .slice(Math.max(0, idx - 3), Math.min(lines.length, idx + 4))
        .map((l, i) => `${lineNumber - 3 + i}: ${l}`)
        .join('\n');
      return {
        locatorCall: `locator('${resolved}')`,
        locatorMethod: 'locator',
        locator: resolved,
        action,
        propertyName: key,
        groupName,
        surroundingCode: surrounding,
      };
    }
  }

  // Check for property-based locator: this.page.locator(this.propName)
  const propRefMatch = line.match(PROPERTY_REF_RE);
  let resolvedLocator: string | null = null;
  let propertyName: string | undefined;

  if (propRefMatch) {
    propertyName = propRefMatch[1];
    resolvedLocator = resolvePropertyLocator(fileContent, propertyName);
  }

  // Extract the locator call pattern
  for (const pat of LOCATOR_LINE_PATTERNS) {
    const m = line.match(pat.re);
    if (m) {
      const rawSelector = pat.selector(m);
      const action = line.match(ACTION_RE)?.[1] ?? 'unknown';
      const surrounding = lines
        .slice(Math.max(0, idx - 3), Math.min(lines.length, idx + 4))
        .map((l, i) => `${lineNumber - 3 + i}: ${l}`)
        .join('\n');
      return {
        locatorCall: pat.call(m),
        locatorMethod: pat.method,
        locator: rawSelector,
        action,
        propertyName,
        surroundingCode: surrounding,
      };
    }
  }

  // If we found a property ref but no inline pattern, try building from resolved value
  if (propertyName && resolvedLocator) {
    const action = line.match(ACTION_RE)?.[1] ?? 'unknown';
    const surrounding = lines
      .slice(Math.max(0, idx - 3), Math.min(lines.length, idx + 4))
      .map((l, i) => `${lineNumber - 3 + i}: ${l}`)
      .join('\n');
    return {
      locatorCall: `locator('${resolvedLocator}')`,
      locatorMethod: 'locator',
      locator: resolvedLocator,
      action,
      propertyName,
      surroundingCode: surrounding,
    };
  }

  return null;
}

/**
 * Main extraction entry point.
 * Returns null if extraction is not possible (e.g., no matching frame, no locator found).
 *
 * Two-pass strategy:
 *  Pass 1 — parse the failing source line (handles inline + property-based locators)
 *  Pass 2 — extract locator from the Playwright error message, search POM files for it
 *           (handles: await expect(button).toBeVisible() where locator was assigned earlier)
 */
export function extractStepInfo(
  errorMessage: string,
  stackTrace: string,
  pomPaths: string[],
  specPath: string,
): FailedStepInfo | null {
  // ── Pass 1: source-line based ────────────────────────────────────────────────
  const frame = selectTargetFrame(stackTrace, pomPaths, specPath);
  if (frame) {
    let fileContent: string;
    try { fileContent = fs.readFileSync(frame.filePath, 'utf-8'); }
    catch { /* fall through to pass 2 */ fileContent = ''; }

    if (fileContent) {
      const extracted = extractFromLine(fileContent, frame.lineNumber);
      if (extracted) {
        const lines = fileContent.split('\n');
        const methodName = findEnclosingMethodName(lines, frame.lineNumber - 1);
        const { tokens, phrase } = deriveIntent(
          extracted.locator,
          extracted.locatorMethod,
          methodName,
          extracted.surroundingCode,
        );
        return {
          locator: extracted.locator,
          locatorCall: extracted.locatorCall,
          locatorMethod: extracted.locatorMethod,
          action: extracted.action,
          filePath: frame.filePath,
          lineNumber: frame.lineNumber,
          methodName,
          propertyName: extracted.propertyName,
          groupName: extracted.groupName,
          intentTokens: tokens,
          intentPhrase: phrase,
          surroundingCode: extracted.surroundingCode,
        };
      }
    }
  }

  // ── Pass 2: error-message based ──────────────────────────────────────────────
  // Playwright always embeds the locator string in the error message.
  // Example: "waiting for locator('xpath=//button[...]')"
  // We extract it, search all POM files for where that string is defined,
  // and build a FailedStepInfo pointing at the property definition line.
  const locatorStr = extractLocatorFromError(errorMessage);
  if (!locatorStr) return null;

  const found = findLocatorInPomFiles(locatorStr, pomPaths, specPath);
  if (!found) return null;

  let pomContent: string;
  try { pomContent = fs.readFileSync(found.filePath, 'utf-8'); }
  catch { return null; }

  const pomLines = pomContent.split('\n');
  const action = frame
    ? (pomLines[frame.lineNumber - 1]?.match(ACTION_RE)?.[1] ?? 'unknown')
    : 'unknown';

  const { tokens, phrase } = deriveIntent(
    locatorStr,
    'locator',
    found.methodName,
    pomLines.slice(Math.max(0, found.lineNumber - 4), found.lineNumber + 2).join('\n'),
  );

  return {
    locator: locatorStr,
    locatorCall: `locator('${locatorStr}')`,
    locatorMethod: 'locator',
    action,
    filePath: found.filePath,
    lineNumber: found.lineNumber,
    methodName: found.methodName,
    propertyName: found.propKey,
    groupName: found.groupName,
    intentTokens: tokens,
    intentPhrase: phrase,
    surroundingCode: pomLines
      .slice(Math.max(0, found.lineNumber - 4), found.lineNumber + 2)
      .map((l, i) => `${found.lineNumber - 3 + i}: ${l}`)
      .join('\n'),
  };
}

/**
 * Improved URL extraction from spec file content.
 * Priority:
 *  1. page.goto('URL') / this.navigate('URL')
 *  2. baseURL constant
 *  3. BASE_URL env reference
 *  4. First https:// string literal
 */
export function extractBaseUrl(specContent: string, envBaseUrl?: string): string | null {
  // 0. @pfqa-url tag injected by the flow generator — most reliable source since it
  //    records the exact URL used during test generation, independent of env variables.
  const pfqaTag = specContent.match(/\/\/\s*@pfqa-url:\s*(https?:\/\/[^\s\n]+)/);
  if (pfqaTag) return pfqaTag[1].trim();

  // 1. Explicit goto / navigate calls
  const gotoMatch = specContent.match(/(?:page\.goto|this\.navigate)\s*\(\s*['\"`](https?:\/\/[^'\"`\s]+)['\"`]/);
  if (gotoMatch) return gotoMatch[1];

  // 2. const BASE_URL = 'https://...'
  const constMatch = specContent.match(/(?:const|let|var)\s+[A-Z_]+\s*=\s*['\"`](https?:\/\/[^'\"`\s]+)['\"`]/);
  if (constMatch) return constMatch[1];

  // 3. Env variable usage → resolve from env
  if (envBaseUrl && specContent.includes('BASE_URL')) return envBaseUrl;

  // 4. Any https:// string literal
  const anyMatch = specContent.match(/['\"`](https?:\/\/[^'\"`\s]+)['\"`]/);
  return anyMatch ? anyMatch[1] : null;
}

/** Normalize a URL to just its origin+path (strip query and hash) for memory keying */
export function normalizeUrlPath(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return url;
  }
}
