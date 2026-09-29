/**
 * POM (Page Object Model) scanning and patching utilities.
 *
 * Responsibilities:
 *  1. Extract selector group names from existing page classes so the AI knows
 *     what properties to reference (e.g. this.experience.cpThemeName).
 *  2. Parse the "// ADD TO:" directive from AI-generated POM blocks.
 *  3. Apply method additions to existing page class files automatically.
 *  4. Run TypeScript compilation checks and surface missing-method errors.
 */
import fs   from 'fs/promises';
import path from 'path';
import { spawnSync } from 'child_process';

// ── Selector Inventory ────────────────────────────────────────────────────────

export interface SelectorGroup {
  name:  string;    // e.g. "experience", "homePage"
  props: string[];  // property names inside the group
  values?: Record<string, string>; // prop → actual CSS string value
}

export interface SelectorInventory {
  rootProps:      string[];                   // top-level scalar / URL properties
  groups:         SelectorGroup[];
  privateSelectors: Array<{ prop: string; value: string }>; // private readonly selectors
}

/**
 * Parse the page-elements object from a page class source and return the
 * names of every selector group and their properties.
 *
 * The AI uses this context to write `this.experience.cpThemeName` instead of
 * hard-coding `'#content-page-setup-theme'`.
 */
export function extractSelectorInventory(content: string): SelectorInventory {
  const rootProps: string[]        = [];
  const groups:    SelectorGroup[] = [];
  const privateSelectors: Array<{ prop: string; value: string }> = [];

  // ── Capture private readonly selector properties ─────────────────────────
  // e.g.  private readonly createBtn = '[data-testid="create-btn"]';
  //        private readonly nameField = '#cp-name';
  const privateRe = /private\s+(?:readonly\s+)?(\w+)\s*=\s*['"`]([^'"`\n]{1,200})['"`]/g;
  let pm: RegExpExecArray | null;
  while ((pm = privateRe.exec(content)) !== null) {
    const value = pm[2];
    // Only keep CSS-like values (contains CSS syntax chars) and skip URLs
    if ((value.includes('[') || value.includes('#') || value.includes('.') || value.includes('>') || value.includes('('))
        && !value.startsWith('http')) {
      privateSelectors.push({ prop: pm[1], value });
    }
  }

  // ── Parse pageElements-style object ───────────────────────────────────────
  const elemsMatch = content.match(/\b\w+(?:Page)?Elements?\b\s*=\s*\{/);
  if (!elemsMatch) return { rootProps, groups, privateSelectors };

  const startIdx  = content.indexOf(elemsMatch[0]);
  const openBrace = content.indexOf('{', startIdx);
  if (openBrace === -1) return { rootProps, groups, privateSelectors };

  let depth = 0;
  let closeBrace = openBrace;
  const limit = Math.min(content.length, openBrace + 120_000);
  for (let i = openBrace; i < limit; i++) {
    if (content[i] === '{') depth++;
    else if (content[i] === '}') {
      depth--;
      if (depth === 0) { closeBrace = i; break; }
    }
  }

  const objBody = content.slice(openBrace + 1, closeBrace);
  const lines   = objBody.split('\n');

  let currentGroup: SelectorGroup | null = null;
  let groupDepth = 0;

  for (const line of lines) {
    const t = line.trim();
    if (!t || t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) continue;

    // Start of a nested group:  key: {
    const groupStart = t.match(/^(\w+)\s*:\s*\{/);
    if (groupStart) {
      groupDepth++;
      if (groupDepth === 1) {
        currentGroup = { name: groupStart[1], props: [], values: {} };
        groups.push(currentGroup);
      }
      continue;
    }

    if ((t === '},' || t === '}') && groupDepth > 0) {
      if (groupDepth === 1) currentGroup = null;
      groupDepth--;
      continue;
    }

    // Property line with optional string value:  key: 'value',
    const propMatch = t.match(/^(\w+)\s*:\s*/);
    if (!propMatch) continue;

    // Try to extract the string value
    const afterColon = t.slice(propMatch[0].length);
    const valMatch   = afterColon.match(/^['"`]([^'"`\n]{1,200})['"`]/);
    const propName   = propMatch[1];
    const propValue  = valMatch ? valMatch[1] : undefined;

    if (groupDepth === 0) {
      rootProps.push(propName);
    } else if (groupDepth === 1 && currentGroup) {
      currentGroup.props.push(propName);
      if (propValue && currentGroup.values) currentGroup.values[propName] = propValue;
    }
  }

  return { rootProps, groups, privateSelectors };
}

/**
 * Render a SelectorInventory for injection into the AI system prompt.
 * Shows actual CSS values so the AI can match explored selectors to existing properties.
 */
export function renderSelectorInventory(inv: SelectorInventory, className: string): string {
  const lines: string[] = [];

  // Private readonly selectors with their actual CSS values
  if (inv.privateSelectors.length) {
    lines.push(`  Private selectors (use via this.propName — do NOT re-declare):`);
    for (const { prop, value } of inv.privateSelectors.slice(0, 60)) {
      lines.push(`    this.${prop.padEnd(32)} = '${value}'`);
    }
    if (inv.privateSelectors.length > 60) {
      lines.push(`    ... (${inv.privateSelectors.length - 60} more private selectors in the file)`);
    }
  }

  // pageElements-style groups with values
  for (const g of inv.groups) {
    if (!g.props.length) continue;
    lines.push(`  this.${g.name} = {`);
    for (const prop of g.props) {
      const value = g.values?.[prop];
      lines.push(`    ${prop}${value ? `: '${value}'` : '  // (dynamic/function value)'}`);
    }
    lines.push(`  }`);
  }

  if (inv.rootProps.length) {
    lines.push(`  Root properties: ${inv.rootProps.join(', ')}`);
  }

  if (!lines.length) return '';
  return [`  ─── Selectors in ${className} ───`, ...lines].join('\n');
}

// ── POM Directive Parsing ─────────────────────────────────────────────────────

export interface PomDirective {
  isAddition:  boolean;
  targetFile:  string | null;  // relative: "src/pages/foo.ts"
  cleanedCode: string;         // ready-to-patch method bodies
}

/**
 * Detect whether the AI-generated POM block is:
 *   (a) an addition to an existing class  →  starts with "// ADD TO: …"
 *   (b) a brand-new class                 →  contains "export class"
 *   (c) ambiguous method bodies            →  has `this.page` but no directive
 */
export function parsePomDirective(pomCode: string): PomDirective {
  // Pattern:  // ADD TO: src/pages/foo.ts
  const addToMatch = pomCode.match(/\/\/\s*ADD\s+TO\s*:\s*(src\/pages\/[^\s\n\r]+\.ts)/i);
  if (addToMatch) {
    const cleanedCode = pomCode
      .replace(/\/\/\s*ADD\s+TO\s*:.*$/gim, '')
      .replace(/^\n+/, '')
      .trim();
    return { isAddition: true, targetFile: addToMatch[1], cleanedCode };
  }

  if (/export\s+(?:default\s+)?class\s+\w+/.test(pomCode)) {
    return { isAddition: false, targetFile: null, cleanedCode: pomCode };
  }

  // Looks like method bodies with no directive — mark as addition, target unknown
  if (/async\s+\w+\s*\(/.test(pomCode) && pomCode.includes('this.page')) {
    return { isAddition: true, targetFile: null, cleanedCode: pomCode.trim() };
  }

  return { isAddition: false, targetFile: null, cleanedCode: pomCode };
}

// ── POM Patching ──────────────────────────────────────────────────────────────

/**
 * Add 4 spaces of indentation to every non-empty line so that method bodies
 * written at column 0 become valid TypeScript class members.
 */
export function normalizeMethodIndent(code: string): string {
  return code
    .split('\n')
    .map(line => (line.trim() === '' ? '' : '    ' + line))
    .join('\n');
}

/**
 * Extract async method names that are DECLARED (not called) in a code snippet.
 * Uses line-anchored patterns so body-level calls like this.page.locator() are ignored.
 * Primary guard against duplicate method insertion.
 */
function extractAsyncMethodNames(code: string): Set<string> {
  const names = new Set<string>();
  // Match declaration lines: optional indentation, then `async methodName(`
  for (const m of code.matchAll(/^[ \t]*async\s+(\w+)\s*\(/gm)) {
    names.add(m[1]);
  }
  return names;
}

/**
 * Extract method/property names declared in a code snippet.
 * Returns Set of names (async myMethod, public myProp, myMethod, etc.)
 * NOTE: kept for property-object detection (Guard 2); for async method dedup
 * prefer extractAsyncMethodNames which is line-anchored and precise.
 */
function extractDeclaredNames(code: string): Set<string> {
  const names = new Set<string>();
  // async methodName( or methodName(  — class methods
  for (const m of code.matchAll(/(?:async\s+)?(\w+)\s*(?:<[^>]*>)?\s*\(/g)) {
    if (!['if', 'for', 'while', 'switch', 'catch', 'function'].includes(m[1])) {
      names.add(m[1]);
    }
  }
  // public/private/protected propName = or propName:
  for (const m of code.matchAll(/(?:public|private|protected|readonly)\s+(\w+)\s*[=:]/g)) {
    names.add(m[1]);
  }
  return names;
}

/**
 * Extract ONLY the public property object names from a class file.
 * These are names declared as `public propName = {` — i.e. selector group objects.
 * Used to guard against a new METHOD shadowing an existing property object.
 */
function extractPublicPropertyNames(code: string): Set<string> {
  const names = new Set<string>();
  for (const m of code.matchAll(/(?:^|\n)\s*public\s+(\w+)\s*=/g)) {
    names.add(m[1]);
  }
  return names;
}

/**
 * Strip methods from `newCode` whose names already appear in `existingContent`.
 * Also blocks any new METHOD that would shadow an existing public PROPERTY OBJECT
 * (e.g. `async contentPlaylistCreate()` can never replace `public contentPlaylistCreate = {}`).
 * Returns the deduplicated code and a list of skipped names.
 */
export function deduplicatePomCode(
  existingContent: string,
  newCode: string,
): { code: string; skipped: string[] } {
  // Primary guard: line-anchored async method name scan — precise, no false positives
  // from method-call expressions inside body lines.
  const existingAsyncMethods = extractAsyncMethodNames(existingContent);
  // Secondary guard: public property object names (prevent method shadowing them).
  const existingPropObjects  = extractPublicPropertyNames(existingContent);
  // Broad set used only for non-async property guard 3.
  const existingNames        = extractDeclaredNames(existingContent);
  const skipped: string[] = [];

  // Split new code into top-level blocks (method or property declaration).
  // Strategy: collect lines into a pending-comment buffer; flush that buffer
  // into a new block only when a declaration line is seen.  This keeps comment
  // lines (// NOTE: ..., // [AI-generated]) attached to the declaration that
  // follows them, so the primary-name extraction always sees the async line.
  const lines = newCode.split('\n');
  const blocks: string[][] = [];
  let current: string[]     = [];
  let pendingComments: string[] = [];

  const isDeclLine = (l: string) =>
    /^(?:async\s+\w|public\s+\w|private\s+\w|protected\s+\w)/.test(l);
  const isCommentLine = (l: string) => /^\/\//.test(l.trim()) && l.trim().startsWith('//');

  for (const line of lines) {
    if (isDeclLine(line)) {
      // New declaration starts here.
      if (current.length) {
        blocks.push(current);
        current = [];
      }
      // Flush pending comments into the new block before the declaration.
      current.push(...pendingComments, line);
      pendingComments = [];
    } else if (isCommentLine(line) || line.trim() === '') {
      // Comment or blank line — buffer it; it belongs to the NEXT declaration.
      // But only buffer if there's already an active block (otherwise it's a
      // leading blank/comment before the first method — attach to first block).
      if (current.length) {
        pendingComments.push(line);
      } else {
        pendingComments.push(line);
      }
    } else {
      // Body line — flush any buffered comments back into the current block.
      current.push(...pendingComments, line);
      pendingComments = [];
    }
  }
  // Flush remainder
  if (pendingComments.length) current.push(...pendingComments);
  if (current.length) blocks.push(current);

  const kept: string[] = [];
  for (const block of blocks) {
    const blockText = block.join('\n');

    // Guard 0 (primary): async method name already exists in the file?
    // Use the line-anchored extractAsyncMethodNames on the block itself to
    // find the method name regardless of surrounding comments.
    const blockAsyncNames = extractAsyncMethodNames(blockText);
    const asyncDupes = [...blockAsyncNames].filter(n => existingAsyncMethods.has(n));
    if (asyncDupes.length) {
      skipped.push(...asyncDupes);
      continue;
    }

    // Detect the PRIMARY declared name of this block (first declaration line).
    const firstDeclLine = block.find(l => isDeclLine(l));
    const primaryName   = firstDeclLine
      ? (/^(?:async\s+)?(\w+)\s*[(<]/.exec(firstDeclLine)?.[1] ??
         /^(?:public|private|protected|readonly)\s+(\w+)\s*[=:]/.exec(firstDeclLine)?.[1])
      : undefined;

    // Guard 1: primary name already exists as a method OR a property object.
    if (primaryName && (existingAsyncMethods.has(primaryName) || existingPropObjects.has(primaryName))) {
      skipped.push(primaryName);
      continue;
    }

    // Guard 2: new async method would shadow an existing public property object.
    const isNewMethod = firstDeclLine && /^async\s+/.test(firstDeclLine);
    if (isNewMethod && primaryName && existingPropObjects.has(primaryName)) {
      skipped.push(primaryName);
      continue;
    }

    // Guard 3: broader duplicate check for non-async symbols (properties, etc.).
    const names = extractDeclaredNames(blockText);
    const dupes = [...names].filter(n => existingNames.has(n) || existingPropObjects.has(n));
    if (dupes.length && blockAsyncNames.size === 0) {
      // Only skip via guard 3 for non-method blocks (properties / constants).
      skipped.push(...dupes);
    } else {
      kept.push(blockText);
    }
  }

  return { code: kept.join('\n'), skipped };
}

/**
 * Validate that every `this.xxx.yyy` reference in the patched file resolves to a
 * known property.  Returns a list of unresolved references (empty = all good).
 *
 * Only checks two-level accesses where the first segment is a literal object
 * property of the class (not a function call result, array index, etc.).
 */
export function validatePropertyRefs(
  classContent: string,
): Array<{ ref: string; line: number }> {
  // Collect all top-level public property names whose value is an object literal
  // e.g.  public experience = { ... }  →  'experience'
  const objectProps = new Map<string, Set<string>>();
  const propRe = /public\s+(\w+)\s*=\s*\{([^}]{0,8000})\}/gs;
  let pm: RegExpExecArray | null;
  while ((pm = propRe.exec(classContent)) !== null) {
    const groupName = pm[1];
    const body = pm[2];
    const keys = new Set<string>();
    for (const km of body.matchAll(/^\s*(\w+)\s*[:(,]/gm)) keys.add(km[1]);
    objectProps.set(groupName, keys);
  }

  if (objectProps.size === 0) return [];

  const errors: Array<{ ref: string; line: number }> = [];
  const lines = classContent.split('\n');

  for (let i = 0; i < lines.length; i++) {
    // Match: this.groupName.propName — but NOT this.groupName.propName(  (function call OK)
    for (const m of lines[i].matchAll(/this\.(\w+)\.(\w+)(?!\s*\()/g)) {
      const [, group, prop] = m;
      if (!objectProps.has(group)) continue;         // not a known literal object — skip
      const keys = objectProps.get(group)!;
      if (!keys.has(prop)) {
        errors.push({ ref: `this.${group}.${prop}`, line: i + 1 });
      }
    }
  }

  return errors;
}

/**
 * Split a flat method-bodies string into per-block chunks.
 * Each block is one top-level declaration (comment + method or property).
 */
function splitIntoBlocks(code: string): string[] {
  const lines  = code.split('\n');
  const blocks: string[][] = [];
  let current: string[] = [];
  for (const line of lines) {
    const isDecl = /^(?:async\s+\w|public\s+\w|private\s+\w|protected\s+\w|\w+\s*[(<])/.test(line);
    if (isDecl && current.length) { blocks.push(current); current = []; }
    current.push(line);
  }
  if (current.length) blocks.push(current);
  return blocks.map(b => b.join('\n'));
}

/**
 * Insert new method bodies into an existing page class file.
 *
 * Guards applied before writing:
 *   1. Duplicate detection — methods already in the class are silently dropped.
 *   2. Property reference validation — catches `this.xxx.yyy` where yyy doesn't exist.
 *      SELF-HEALING: instead of aborting the whole patch, strips only the offending
 *      method blocks so that property declarations and valid methods still apply.
 *      Only aborts if nothing valid remains.
 */
export async function applyPomPatch(
  fullPath: string,
  newMethods: string,
  log: (msg: string) => void,
): Promise<void> {
  let existing: string;
  try {
    existing = await fs.readFile(fullPath, 'utf-8');
  } catch {
    throw new Error(`POM patch: cannot read target file ${fullPath}`);
  }

  // ── Guard 1: deduplicate ──────────────────────────────────────────────────
  const { code: deduped, skipped } = deduplicatePomCode(existing, newMethods);
  if (skipped.length) {
    log(`[POM Patcher] Skipped duplicate declarations: ${skipped.join(', ')}`);
  }
  let codeToInsert = deduped.trim();
  if (!codeToInsert) {
    log(`[POM Patcher] Nothing new to add — all methods already exist in ${path.basename(fullPath)}`);
    return;
  }

  // ── Guard 2: property reference self-healing ──────────────────────────────
  // Build a probe to check which NEW blocks have broken property refs.
  // Instead of aborting, strip only the offending method blocks and apply the rest.
  {
    const probeBase  = existing.slice(0, existing.lastIndexOf('\n}'));
    const blocks     = splitIntoBlocks(codeToInsert);
    const validBlocks: string[] = [];
    const stripped:   string[] = [];

    for (const block of blocks) {
      const probe    = probeBase + '\n\n' + block + '\n}';
      const badRefs  = validatePropertyRefs(probe);
      if (badRefs.length) {
        // Extract the primary method/prop name for the log message
        const nameLine = block.split('\n').find(l =>
          /^(?:async\s+)?(\w+)\s*[(<]/.test(l) || /^(?:public|private)\s+(\w+)/.test(l));
        const name = nameLine
          ? (/^(?:async\s+)?(\w+)\s*[(<]/.exec(nameLine)?.[1] ?? nameLine.slice(0, 30))
          : block.slice(0, 30);
        stripped.push(name);
        log(`[POM Patcher] Auto-healed: stripped "${name}" (refs unknown properties: ${badRefs.map(r => r.ref).join(', ')})`);
      } else {
        validBlocks.push(block);
      }
    }

    if (stripped.length > 0 && validBlocks.length === 0) {
      throw new Error(
        `POM patch aborted — every code block references undefined properties in ${path.basename(fullPath)}.\n` +
        `Stripped blocks: ${stripped.join(', ')}\n` +
        `Ensure the ADD TO block declares the selector property objects BEFORE the methods that reference them.`,
      );
    }

    if (stripped.length > 0) {
      codeToInsert = validBlocks.join('\n\n').trim();
      log(`[POM Patcher] Applied ${validBlocks.length} valid block(s); ${stripped.length} method(s) stripped (will be regenerated by compile-repair loop).`);
    }
  }

  // ── Stamp & indent ────────────────────────────────────────────────────────
  const stamped = codeToInsert.includes('// [AI-generated]')
    ? codeToInsert
    : `// [AI-generated] — inserted by flow-generator on ${new Date().toISOString().slice(0, 10)}\n${codeToInsert}`;

  const indented     = normalizeMethodIndent(stamped);
  const lastBraceIdx = existing.lastIndexOf('\n}');
  if (lastBraceIdx === -1) {
    throw new Error(`POM patch: cannot find class closing brace in ${path.basename(fullPath)}`);
  }

  const patched =
    existing.slice(0, lastBraceIdx) +
    '\n\n' +
    indented +
    '\n' +
    existing.slice(lastBraceIdx);

  await fs.writeFile(fullPath, patched, 'utf-8');
  log(`[POM Patcher] Patched existing class: ${path.relative(process.cwd(), fullPath)}`);
}

/**
 * Replace existing method bodies in a page class file.
 * Unlike applyPomPatch (which skips duplicates), this finds each method
 * by name and replaces its full body — used for locator-fix repairs where
 * the method already exists but uses a broken selector.
 *
 * The `newMethods` string may contain multiple method definitions.
 * Only methods that ALREADY EXIST in the class are replaced; new methods
 * are inserted via applyPomPatch so deduplication still protects pure additions.
 */
export async function applyPomReplace(
  fullPath: string,
  newMethods: string,
  log: (msg: string) => void,
): Promise<{ replaced: string[]; notFound: string[] }> {
  let existing: string;
  try {
    existing = await fs.readFile(fullPath, 'utf-8');
  } catch {
    throw new Error(`POM replace: cannot read target file ${fullPath}`);
  }

  const blocks = splitIntoBlocks(newMethods.trim());
  const replaced: string[] = [];
  const notFound: string[] = [];
  let current = existing;

  for (const block of blocks) {
    if (!block.trim()) continue;

    // Extract the method name from the first line of the block
    const firstLine = block.trim().split('\n')[0];
    const nameMatcher =
      /^(?:async\s+)?(\w+)\s*\(/.exec(firstLine) ??
      /^(?:public|private|protected)\s+(?:async\s+)?(\w+)\s*\(/.exec(firstLine);

    if (!nameMatcher) { notFound.push(firstLine.slice(0, 40)); continue; }
    const methodName = nameMatcher[1];

    // Find the existing method in the file: look for `async methodName(` or `methodName(`
    // Match from its start to its closing brace (matching brace depth)
    const methodStartRe = new RegExp(
      `([ \\t]*)(?:\\/\\/[^\\n]*\\n[ \\t]*)*` +  // optional preceding comment lines
      `(?:public\\s+|private\\s+|protected\\s+)?(?:async\\s+)?${methodName}\\s*\\(`,
    );
    const startMatch = methodStartRe.exec(current);
    if (!startMatch) { notFound.push(methodName); continue; }

    const indent = startMatch[1];
    const bodyStart = startMatch.index;

    // Walk forward to find the closing brace of this method
    let depth = 0;
    let bodyEnd = bodyStart;
    let foundOpen = false;
    for (let i = bodyStart; i < current.length; i++) {
      if (current[i] === '{') { depth++; foundOpen = true; }
      else if (current[i] === '}') {
        depth--;
        if (foundOpen && depth === 0) { bodyEnd = i + 1; break; }
      }
    }

    if (!foundOpen || bodyEnd <= bodyStart) { notFound.push(methodName); continue; }

    // Re-indent the replacement block to match the existing indentation
    const indented = block.trim().split('\n').map((line, idx) =>
      idx === 0 ? `${indent}${line.trimStart()}` : `${indent}${line.trimStart()}`,
    ).join('\n');

    const stamped = indented.includes('// [AI-')
      ? indented
      : `${indent}// [AI-fixed] — selector healed on ${new Date().toISOString().slice(0, 10)}\n${indented}`;

    current = current.slice(0, bodyStart) + stamped + current.slice(bodyEnd);
    replaced.push(methodName);
    log(`[POM Patcher] Replaced method: ${methodName} in ${path.basename(fullPath)}`);
  }

  if (replaced.length > 0) {
    await fs.writeFile(fullPath, current, 'utf-8');
    log(`[POM Patcher] Wrote ${replaced.length} method replacement(s) to ${path.relative(process.cwd(), fullPath)}`);
  }

  return { replaced, notFound };
}

// ── TypeScript Compilation Check ─────────────────────────────────────────────

export interface CompileError {
  file:    string;
  line:    number;
  col:     number;
  code:    number;
  message: string;
}

/**
 * Run `tsc --noEmit --skipLibCheck` and return errors in the spec file AND any
 * POM files that were touched (pomPaths).  This catches runtime-undefined property
 * references like `this.experience.nonExistentKey` that compile-time type checks
 * would normally surface if the object's type is fully inferred.
 */
export function compilationErrors(
  specPath:    string,
  projectRoot: string,
  pomPaths:    string[] = [],
): CompileError[] {
  const result = spawnSync('npx', ['tsc', '--noEmit', '--skipLibCheck'], {
    encoding: 'utf-8',
    cwd:      projectRoot,
    stdio:    ['pipe', 'pipe', 'pipe'],
  });

  const output = (result.stdout ?? '') + (result.stderr ?? '');
  if (!output.trim()) return [];

  // Build a set of normalised basenames and relative paths to match against
  const watchFiles = new Set<string>();
  const addWatch = (p: string) => {
    watchFiles.add(path.basename(p));
    watchFiles.add(path.relative(projectRoot, p).replace(/\\/g, '/'));
  };
  addWatch(specPath);
  for (const p of pomPaths) addWatch(p);

  const errors: CompileError[] = [];
  for (const line of output.split('\n')) {
    const m = line.match(/^(.+\.ts)\((\d+),(\d+)\):\s+error\s+TS(\d+):\s+(.+)$/);
    if (!m) continue;
    const errFile = m[1].replace(/\\/g, '/');
    const errBase = path.basename(errFile);
    const matches = [...watchFiles].some(w => errFile.endsWith(w) || errBase === w);
    if (!matches) continue;
    errors.push({
      file:    m[1],
      line:    parseInt(m[2]),
      col:     parseInt(m[3]),
      code:    parseInt(m[4]),
      message: m[5].trim(),
    });
  }

  return errors;
}

/**
 * Extract "Property 'X' does not exist on type 'Y'" errors as missing-method
 * descriptors. Deduplicates by className + method.
 */
export function missingMethodsFromErrors(
  errors: CompileError[],
): Array<{ method: string; className: string }> {
  const seen   = new Set<string>();
  const result: Array<{ method: string; className: string }> = [];

  for (const err of errors) {
    const m = err.message.match(/Property '(\w+)' does not exist on type '(\w+)'/);
    if (!m) continue;
    const key = `${m[2]}.${m[1]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ method: m[1], className: m[2] });
  }

  return result;
}

/**
 * When `Property 'methodX' does not exist on type 'WrongClass'` compile errors appear,
 * this healer checks all page classes to see if another class has that method.
 * If yes, it identifies the correct fixture name and rewrites the spec to use it —
 * instead of adding phantom methods to the wrong class.
 *
 * Returns true if any fixture remap was applied.
 *
 * Example: spec uses `templatedExperiencePage.visitContentPlaylists()` but
 * `visitContentPlaylists` only exists on `ContentPlaylistPage` (fixture: contentPlaylistPage).
 * Healer rewrites all calls + fixture arg to `contentPlaylistPage`.
 */
export async function healWrongClassMethodErrors(
  errors:      CompileError[],
  specPath:    string,
  projectRoot: string,
  log:         (msg: string) => void,
): Promise<boolean> {
  const missing = missingMethodsFromErrors(errors);
  if (missing.length === 0) return false;

  // Group by the wrong class name
  const byClass = new Map<string, string[]>();
  for (const { method, className } of missing) {
    if (!byClass.has(className)) byClass.set(className, []);
    byClass.get(className)!.push(method);
  }

  let specSource: string;
  try { specSource = await fs.readFile(specPath, 'utf-8'); } catch { return false; }

  // Build: className → [method names] index from ALL page files
  const pagesDir = path.join(projectRoot, 'src/pages');
  const classMethodIndex = new Map<string, Set<string>>(); // className → Set<method>
  try {
    const files = await fs.readdir(pagesDir);
    for (const file of files) {
      if (!file.endsWith('.ts')) continue;
      const content = await fs.readFile(path.join(pagesDir, file), 'utf-8').catch(() => '');
      const cm = content.match(/export(?:\s+default)?\s+class\s+(\w+)/);
      if (!cm) continue;
      const methods = new Set<string>();
      for (const mm of content.matchAll(/(?:^|\n)\s*async\s+(\w+)\s*\(/gm)) methods.add(mm[1]);
      for (const mm of content.matchAll(/(?:^|\n)\s*(\w+)\s*\(/gm)) methods.add(mm[1]);
      classMethodIndex.set(cm[1], methods);
    }
  } catch { return false; }

  // Build fixture registry: className → fixtureName
  const fixtureRegistry = await buildFixtureClassMap(projectRoot);
  const classToFixture  = new Map<string, string>();
  for (const [fixture, className] of fixtureRegistry) classToFixture.set(className, fixture);

  let updatedSpec = specSource;
  let healed      = false;

  for (const [wrongClass, methods] of byClass) {
    // Find the fixture name for wrongClass
    const wrongFixture = classToFixture.get(wrongClass);
    if (!wrongFixture) continue; // can't identify current fixture in spec

    // For each missing method, find which class actually has it
    const remapTarget = new Map<string, string>(); // method → correctFixture
    for (const method of methods) {
      for (const [className, methodSet] of classMethodIndex) {
        if (className === wrongClass) continue;
        if (methodSet.has(method)) {
          const correctFixture = classToFixture.get(className);
          if (correctFixture) {
            remapTarget.set(method, correctFixture);
            break;
          }
        }
      }
    }
    if (remapTarget.size === 0) continue;

    // If all missing methods map to the same correct fixture, remap the entire fixture
    const targets = new Set(remapTarget.values());
    if (targets.size === 1) {
      const correctFixture = [...targets][0];
      const argRe  = new RegExp(`(async\\s*\\([^)]*?)\\b${wrongFixture}\\b`, 'g');
      const callRe = new RegExp(`(?<![.\\w])${wrongFixture}\\.`, 'g');
      const newSpec = updatedSpec
        .replace(argRe,  (_m, prefix) => `${prefix}${correctFixture}`)
        .replace(callRe, `${correctFixture}.`);
      if (newSpec !== updatedSpec) {
        updatedSpec = newSpec;
        log(`[POM Patcher] Auto-healed spec: remapped fixture "${wrongFixture}" → "${correctFixture}" (${methods.length} method(s) found in ${correctFixture})`);
        healed = true;
      }
    } else {
      // Methods spread across multiple fixtures — remap call by call
      for (const [method, correctFixture] of remapTarget) {
        const callRe = new RegExp(`(?<![.\\w])${wrongFixture}\\.(${method})(?=\\s*\\()`, 'g');
        const newSpec = updatedSpec.replace(callRe, `${correctFixture}.$1`);
        if (newSpec !== updatedSpec) {
          updatedSpec = newSpec;
          log(`[POM Patcher] Auto-healed spec: ${wrongFixture}.${method}() → ${correctFixture}.${method}()`);
          healed = true;
        }
      }
    }
  }

  if (healed) await fs.writeFile(specPath, updatedSpec, 'utf-8');
  return healed;
}

/**
 * Parse TS2304 "Cannot find name 'X'" errors that arise when the spec uses a
 * fixture variable name that wasn't declared in the destructured args, or when
 * the AI invented a non-existent fixture name.
 *
 * Returns distinct unknown names found in the spec file only.
 */
export function unknownNameErrorsFromErrors(errors: CompileError[]): string[] {
  const seen   = new Set<string>();
  const result: string[] = [];
  for (const err of errors) {
    if (err.code !== 2304) continue;
    const m = err.message.match(/Cannot find name '(\w+)'/);
    if (!m) continue;
    if (!seen.has(m[1])) { seen.add(m[1]); result.push(m[1]); }
  }
  return result;
}

/**
 * Self-heal TS2304 "Cannot find name 'wrongFixtureName'" errors by cross-referencing
 * the unknown name against the fixture registry. If a close match exists (edit-distance
 * ≤ 2 or common prefix), rewrites all usages in the spec.
 *
 * Returns true if any healing was applied.
 */
export async function healUnknownFixtureErrors(
  errors:      CompileError[],
  specPath:    string,
  projectRoot: string,
  log:         (msg: string) => void,
): Promise<boolean> {
  const unknowns = unknownNameErrorsFromErrors(errors);
  if (unknowns.length === 0) return false;

  // Build the full known fixture name set from the registry
  const fixtureFile = path.join(projectRoot, 'src/fixtures/pageObjects.ts');
  let registrySource = '';
  try { registrySource = await fs.readFile(fixtureFile, 'utf-8'); } catch { return false; }

  const knownFixtures = new Set<string>();
  for (const m of registrySource.matchAll(/(\w+)\s*:\s*\w+\s*;/g)) knownFixtures.add(m[1]);

  let specSource = '';
  try { specSource = await fs.readFile(specPath, 'utf-8'); } catch { return false; }

  let healed = false;
  let updatedSpec = specSource;

  for (const unknown of unknowns) {
    if (knownFixtures.has(unknown)) continue; // already valid — skip

    // Find the closest known fixture name
    let bestMatch: string | null = null;
    let bestScore = Infinity;
    for (const known of knownFixtures) {
      const dist = editDistance(unknown, known);
      // Also accept common-prefix matches (≥ 6 chars shared prefix)
      const prefixLen = commonPrefixLen(unknown, known);
      const score = dist - (prefixLen >= 6 ? 2 : 0);
      if (score < bestScore && dist <= 3) { bestScore = score; bestMatch = known; }
    }

    if (!bestMatch) {
      log(`[POM Patcher] WARN: Cannot heal unknown fixture name "${unknown}" — no close match in registry.`);
      continue;
    }

    // Rewrite all usages: fixture arg + all method calls
    // 1. In the async args: replace `unknown` → `bestMatch` in destructuring
    const argRe  = new RegExp(`(async\\s*\\([^)]*?)\\b${unknown}\\b`, 'g');
    const callRe = new RegExp(`(?<![.\\w])${unknown}\\.`, 'g');
    const newSpec = updatedSpec
      .replace(argRe,  (_m, prefix) => `${prefix}${bestMatch}`)
      .replace(callRe, `${bestMatch}.`);

    if (newSpec !== updatedSpec) {
      updatedSpec = newSpec;
      log(`[POM Patcher] Auto-healed spec: replaced fixture "${unknown}" → "${bestMatch}"`);
      healed = true;
    }
  }

  if (healed) await fs.writeFile(specPath, updatedSpec, 'utf-8');
  return healed;
}

function editDistance(a: string, b: string): number {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => Array.from({ length: n + 1 }, (_, j) => i === 0 ? j : j === 0 ? i : 0));
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = a[i-1] === b[j-1] ? dp[i-1][j-1] : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
  return dp[m][n];
}

function commonPrefixLen(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

/**
 * Resolve the page-class source file from a class name using the fixture registry.
 * Returns the absolute path, or null if not found.
 */
export async function resolveClassFile(
  className:   string,
  projectRoot: string,
): Promise<string | null> {
  const pagesDir = path.join(projectRoot, 'src/pages');
  try {
    const files = await fs.readdir(pagesDir);
    for (const file of files) {
      if (!file.endsWith('.ts')) continue;
      const content = await fs.readFile(path.join(pagesDir, file), 'utf-8').catch(() => '');
      if (new RegExp(`\\bclass\\s+${className}\\b`).test(content)) {
        return path.join(pagesDir, file);
      }
    }
  } catch { /* ignore */ }
  return null;
}

// ── Property-Key Cross-Reference Healer ──────────────────────────────────────

export interface PropertyKeyError {
  missingKey: string;       // e.g. 'nameInput'
  groupName:  string | null; // e.g. 'contentPlaylistCreate' (from spec access path)
  specLine:   number;
}

/**
 * Parse "Property 'X' does not exist on type '{ ... }'" errors.
 * These arise when the spec accesses pageObj.propGroup.missingKey and the
 * selector group doesn't have that key.  They differ from method-missing errors
 * in that the type is an object literal `{ ... }`, not a class name.
 *
 * Returns the missing key + line number for each such error.
 */
export function propertyKeyErrorsFromErrors(errors: CompileError[]): PropertyKeyError[] {
  const seen   = new Set<string>();
  const result: PropertyKeyError[] = [];
  for (const err of errors) {
    // Match: Property 'nameInput' does not exist on type '{ createExperienceButton: ...'
    const m = err.message.match(/Property '(\w+)' does not exist on type '\{/);
    if (!m) continue;
    const key = `${err.line}:${m[1]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ missingKey: m[1], groupName: null, specLine: err.line });
  }
  return result;
}

/**
 * Self-heal "property key missing from selector group" errors automatically.
 *
 * Strategy:
 *   1. For each missingKey error, scan the spec source at the error line to find
 *      which selector group is being accessed: pageObj.groupName.missingKey.
 *   2. Search ALL property groups in the page class for a matching key.
 *      If found in a different group: rewrite the spec references to the correct group.
 *      If found in the SAME group already (race condition): no-op.
 *   3. If not found anywhere: add the missingKey to the target group by copying the
 *      selector value from a method body in the class or from the spec context.
 *
 * Returns true if any healing was applied.
 */
export async function healPropertyKeyErrors(
  errors:       CompileError[],
  specPath:     string,
  pomFilePath:  string,
  log:          (msg: string) => void,
): Promise<boolean> {
  const keyErrors = propertyKeyErrorsFromErrors(errors);
  if (keyErrors.length === 0) return false;

  let specSource: string;
  let pomSource:  string;
  try {
    specSource = await fs.readFile(specPath, 'utf-8');
    pomSource  = await fs.readFile(pomFilePath, 'utf-8');
  } catch { return false; }

  const specLines = specSource.split('\n');

  // Build a map of groupName → { key → selectorValue } from the POM class
  const pomGroups = new Map<string, Map<string, string>>();
  const groupRe   = /public\s+(\w+)\s*=\s*\{([^}]{0,8000})\}/gs;
  let gm: RegExpExecArray | null;
  while ((gm = groupRe.exec(pomSource)) !== null) {
    const groupName  = gm[1];
    const body       = gm[2];
    const propMap    = new Map<string, string>();
    for (const pm of body.matchAll(/^\s*(\w+)\s*:\s*['"`]([^'"`\n]{1,200})['"`]/gm)) {
      propMap.set(pm[1], pm[2]);
    }
    pomGroups.set(groupName, propMap);
  }

  let healed       = false;
  let updatedSpec  = specSource;
  let updatedPom   = pomSource;

  for (const { missingKey, specLine } of keyErrors) {
    // Step 1: find the access pattern in the spec at the error line
    const lineIdx   = specLine - 1;
    if (lineIdx < 0 || lineIdx >= specLines.length) continue;
    const line      = specLines[lineIdx];

    // Match: something.groupName.missingKey  (e.g. contentPlaylistPage.contentPlaylistCreate.nameInput)
    const accessRe  = /(\w+)\.(\w+)\.\w+/g;
    let accessMatch: RegExpExecArray | null;
    let groupName:   string | null = null;
    while ((accessMatch = accessRe.exec(line)) !== null) {
      const candidate = accessMatch[2];
      if (pomGroups.has(candidate)) { groupName = candidate; break; }
    }
    if (!groupName) continue;

    // Step 2: search all groups for a matching key
    let foundInGroup: string | null = null;
    let foundValue:   string | null = null;
    for (const [gName, propMap] of pomGroups.entries()) {
      if (propMap.has(missingKey)) {
        foundInGroup = gName;
        foundValue   = propMap.get(missingKey) ?? null;
        break;
      }
    }

    if (foundInGroup && foundInGroup !== groupName) {
      // Rewrite spec: replace all .groupName.missingKey with .foundInGroup.missingKey
      const before = new RegExp(`\\.${groupName}\\.${missingKey}(?!\\w)`, 'g');
      const after  = `.${foundInGroup}.${missingKey}`;
      const newSpec = updatedSpec.replace(before, after);
      if (newSpec !== updatedSpec) {
        updatedSpec = newSpec;
        log(`[POM Patcher] Auto-healed spec: replaced .${groupName}.${missingKey} → .${foundInGroup}.${missingKey}`);
        healed = true;
      }
    } else if (!foundInGroup && foundValue === null) {
      // Step 3: the key doesn't exist anywhere — look for it in method bodies
      // Pattern: this.page.locator(this.someGroup.missingKey) or locator('#some-id')
      // Heuristic: find a method that fills/clicks the field and extract its selector
      const methodRe  = new RegExp(`async\\s+\\w+.*?\\{[^}]*\\.locator\\((['"\`])([^'"\`\\n]{1,200})\\1\\)[^}]*}`, 'gs');
      let   bestValue: string | null = null;
      let   mm: RegExpExecArray | null;
      while ((mm = methodRe.exec(pomSource)) !== null) {
        // Rough heuristic: if the method name contains the key as a substring, use the selector
        const methodChunk = mm[0].toLowerCase();
        if (methodChunk.includes(missingKey.toLowerCase().slice(0, 6))) {
          bestValue = mm[2];
          break;
        }
      }

      if (bestValue) {
        // Add the missing key to the target group in the POM
        const groupBodyRe = new RegExp(`(public\\s+${groupName}\\s*=\\s*\\{)([^}]{0,8000})(\\})`, 's');
        const newPom = updatedPom.replace(groupBodyRe, (_full, open, body, close) => {
          const insertion = `    ${missingKey}: '${bestValue}',\n`;
          return `${open}${body}${insertion}${close}`;
        });
        if (newPom !== updatedPom) {
          updatedPom = newPom;
          log(`[POM Patcher] Auto-healed POM: added ${groupName}.${missingKey} = '${bestValue}'`);
          healed = true;
        }
      }
    }
  }

  if (healed) {
    await fs.writeFile(specPath, updatedSpec, 'utf-8');
    await fs.writeFile(pomFilePath, updatedPom, 'utf-8');
  }
  return healed;
}

// ── Post-Generation Consistency Check ────────────────────────────────────────

/**
 * Build a map of { fixtureName → ClassName } by parsing the fixture registry file.
 * e.g. "contentPlaylistPage" → "ContentPlaylistPage"
 */
export async function buildFixtureClassMap(projectRoot: string): Promise<Map<string, string>> {
  const fixtureFile = path.join(projectRoot, 'src/fixtures/pageObjects.ts');
  const map = new Map<string, string>();
  try {
    const src = await fs.readFile(fixtureFile, 'utf-8');
    // Match: fixtureName: async ({ page }, use) => { await use(new ClassName(page)); }
    for (const m of src.matchAll(/(\w+):\s*async\s*\([^)]*\)\s*=>\s*\{[^}]*new\s+(\w+)\s*\(/g)) {
      map.set(m[1], m[2]);
    }
  } catch { /* ignore */ }
  return map;
}

/**
 * Check spec file for `fixtureVar.groupName.key` accesses that don't match the
 * actual POM group structure, and auto-heal them (rewrite to correct group path).
 *
 * This runs immediately after spec + POM are written, before compilation,
 * so it catches group-path mistakes before they surface as TS errors.
 *
 * Returns true if any rewrite was made.
 */
export async function checkSpecPomConsistency(
  specPath:    string,
  pomFiles:    string[],
  projectRoot: string,
  log:         (msg: string) => void,
): Promise<boolean> {
  let specSource: string;
  try { specSource = await fs.readFile(specPath, 'utf-8'); } catch { return false; }

  const fixtureClassMap = await buildFixtureClassMap(projectRoot);

  // Build groupKey → fileName lookup across all touched POM files
  type GroupMap = Map<string, Map<string, string>>; // groupName → key → value
  const pomGroupsByFile = new Map<string, GroupMap>();

  for (const pomFile of pomFiles) {
    const src = await fs.readFile(pomFile, 'utf-8').catch(() => '');
    if (!src) continue;
    const groups: GroupMap = new Map();
    const groupRe = /public\s+(\w+)\s*=\s*\{([^}]{0,8000})\}/gs;
    let gm: RegExpExecArray | null;
    while ((gm = groupRe.exec(src)) !== null) {
      const propMap = new Map<string, string>();
      for (const pm of gm[2].matchAll(/^\s*(\w+)\s*:\s*['"`]([^'"\`\n]{0,200})['"`]/gm)) {
        propMap.set(pm[1], pm[2]);
      }
      groups.set(gm[1], propMap);
    }
    pomGroupsByFile.set(pomFile, groups);
  }

  // Find all 3-part property accesses in the spec: fixtureVar.group.key
  // e.g. contentPlaylistPage.contentPlaylistCreate.nameInput
  const accessRe = /\b(\w+)\.(\w+)\.(\w+)\b/g;
  const accesses = new Map<string, { fixtureName: string; groupName: string; key: string }>();
  for (const m of specSource.matchAll(accessRe)) {
    const [full, fixtureName, groupName, key] = m;
    // Skip patterns that look like method chains (e.g. page.getByRole.first)
    if (fixtureName === 'page' || fixtureName === 'test' || fixtureName === 'expect') continue;
    accesses.set(full, { fixtureName, groupName, key });
  }

  let updatedSpec = specSource;
  let healed = false;

  for (const [_full, { fixtureName, groupName, key }] of accesses) {
    // Look up which POM file this fixture resolves to
    const className = fixtureClassMap.get(fixtureName);
    if (!className) continue;

    // Find the POM file that contains this class
    let pomGroups: GroupMap | null = null;
    for (const [pomFile, groups] of pomGroupsByFile.entries()) {
      const src = await fs.readFile(pomFile, 'utf-8').catch(() => '');
      if (new RegExp(`\\bclass\\s+${className}\\b`).test(src)) {
        pomGroups = groups;
        break;
      }
    }
    if (!pomGroups) continue;

    // Check if groupName exists AND key exists within it
    const targetGroup = pomGroups.get(groupName);
    if (targetGroup && targetGroup.has(key)) continue; // all good

    // Key not in expected group — search other groups for this key
    let correctGroup: string | null = null;
    for (const [gName, propMap] of pomGroups.entries()) {
      if (gName !== groupName && propMap.has(key)) {
        correctGroup = gName;
        break;
      }
    }

    if (correctGroup) {
      const before = new RegExp(`\\.${groupName}\\.${key}(?!\\w)`, 'g');
      const after  = `.${correctGroup}.${key}`;
      const newSpec = updatedSpec.replace(before, after);
      if (newSpec !== updatedSpec) {
        updatedSpec = newSpec;
        log(`[POM Patcher] Consistency fix: ${fixtureName}.${groupName}.${key} → .${correctGroup}.${key}`);
        healed = true;
      }
    } else {
      log(`[POM Patcher] WARN: ${fixtureName}.${groupName}.${key} — key "${key}" not found in any group of ${className}`);
    }
  }

  if (healed) {
    await fs.writeFile(specPath, updatedSpec, 'utf-8');
  }
  return healed;
}
