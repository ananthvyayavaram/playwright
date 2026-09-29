/**
 * Patches TypeScript source files with a healed locator expression.
 *
 * Handles two cases:
 *
 * Case 1 — Inline locator:
 *   await this.page.locator('#old-sel').click();
 *   → await this.page.getByRole('button', {name:'Login'}).click();
 *
 * Case 2 — Property-based locator:
 *   private loginBtn = '#old-sel';
 *   await this.page.locator(this.loginBtn).click();
 *   → private loginBtn = '[data-testid="login-button"]';  (if new expression is css/testid)
 *   OR converts the method to use an inline expression for semantic locators.
 *
 * The patcher always backs up the original file before writing.
 */
import fs from 'fs';
import path from 'path';
import type { FailedStepInfo } from './types';

interface PatchResult {
  success: boolean;
  backupPath: string;
  patchedFile: string;
  occurrencesPatched: number;
  note?: string;
}

/** Returns the Playwright object prefix used in the file: 'this.page' or 'page' */
function detectPagePrefix(fileContent: string): string {
  return fileContent.includes('this.page.') ? 'this.page' : 'page';
}

/**
 * Build the BEFORE and AFTER strings for an inline locator replacement.
 *
 * Before: this.page.locator('#login-btn')
 * After:  this.page.getByRole('button', {name:'Login'})
 */
function buildInlineReplacement(
  originalLocatorCall: string,
  healedExpression: string,
  pagePrefix: string,
): { from: string; to: string } {
  return {
    from: `${pagePrefix}.${originalLocatorCall}`,
    to:   `${pagePrefix}.${healedExpression}`,
  };
}

/**
 * Build the BEFORE and AFTER strings for a property-based replacement.
 *
 * Handles two POM patterns:
 *   Scalar:  private propName = '#old'  →  private propName = 'new'
 *   Grouped: propKey: '#old',           →  propKey: 'new',   (inside public group = { })
 *
 * If the healed expression is a Playwright method call (getByRole, etc.),
 * the inline usage in the method is replaced instead.
 *
 * @param groupName  When set, the property is inside an object group (use colon syntax)
 */
function buildPropertyReplacement(
  propertyName: string,
  originalLocator: string,
  healedExpression: string,
  pagePrefix: string,
  groupName?: string,
): { from: string; to: string; type: 'property' | 'grouped' | 'inline' } {
  // Grouped property: `propKey: 'xpath=...',`  — use colon syntax
  if (groupName) {
    for (const q of ["'", '"', '`'] as const) {
      const from = `${propertyName}: ${q}${originalLocator}${q}`;
      if (originalLocator && from.length > 0) {
        // For grouped props, always store a plain CSS/xpath string (never a Playwright expression)
        const newVal = healedExpression.startsWith('getBy') || healedExpression.startsWith('locator(')
          ? originalLocator  // keep original — inline replacement handled separately
          : healedExpression;
        return { from, to: `${propertyName}: '${newVal}'`, type: 'grouped' };
      }
    }
  }

  // Scalar property: `private propName = '#old'`
  const isCssStyle = !healedExpression.startsWith('getBy') && !healedExpression.startsWith('locator(');
  if (isCssStyle) {
    for (const q of ["'", '"', '`'] as const) {
      const from = `${propertyName} = ${q}${originalLocator}${q}`;
      if (from.length > 0) {
        return { from, to: `${propertyName} = '${healedExpression}'`, type: 'property' };
      }
    }
  }

  // Semantic expression (getByRole etc.) — convert the method's locator call to inline
  return {
    from: `${pagePrefix}.locator(this.${propertyName})`,
    to:   `${pagePrefix}.${healedExpression}`,
    type: 'inline',
  };
}

/**
 * Apply a text replacement throughout the file, counting occurrences.
 * Only replaces full-word matches to avoid partial-selector collisions.
 */
function replaceAll(content: string, from: string, to: string): { result: string; count: number } {
  if (!from || from === to) return { result: content, count: 0 };
  const parts = content.split(from);
  const count = parts.length - 1;
  return { result: parts.join(to), count };
}

/**
 * Main patch function.
 *
 * @param stepInfo  Info about the failing step (file, line, locator, method)
 * @param healedExpression  The Playwright locator expression to use instead,
 *                          e.g. "getByRole('button', {name:'Login'})"
 */
export function patchFile(stepInfo: FailedStepInfo, healedExpression: string): PatchResult {
  const { filePath, locator, locatorCall, propertyName, groupName } = stepInfo;

  let fileContent: string;
  try {
    fileContent = fs.readFileSync(filePath, 'utf-8');
  } catch (err) {
    return {
      success: false,
      backupPath: '',
      patchedFile: filePath,
      occurrencesPatched: 0,
      note: `Cannot read file: ${(err as Error).message}`,
    };
  }

  const backupPath = `${filePath}.bak`;
  try {
    fs.writeFileSync(backupPath, fileContent, 'utf-8');
  } catch {
    // Non-fatal — proceed without backup
  }

  const pagePrefix = detectPagePrefix(fileContent);
  let replacement: { from: string; to: string };

  if (propertyName) {
    const r = buildPropertyReplacement(propertyName, locator, healedExpression, pagePrefix, groupName);
    replacement = r;
  } else {
    replacement = buildInlineReplacement(locatorCall, healedExpression, pagePrefix);
  }

  const { result, count } = replaceAll(fileContent, replacement.from, replacement.to);

  if (count === 0) {
    // Fallback: try a looser replacement for the raw locator string value
    const fallbackFrom = `'${locator}'`;
    const fallbackTo   = `'${healedExpression}'`;
    const fallback = replaceAll(fileContent, fallbackFrom, fallbackTo);
    if (fallback.count > 0) {
      try {
        fs.writeFileSync(filePath, fallback.result, 'utf-8');
        return { success: true, backupPath, patchedFile: filePath, occurrencesPatched: fallback.count, note: 'Used fallback string replacement' };
      } catch (err) {
        return { success: false, backupPath, patchedFile: filePath, occurrencesPatched: 0, note: `Write failed: ${(err as Error).message}` };
      }
    }
    return {
      success: false,
      backupPath,
      patchedFile: filePath,
      occurrencesPatched: 0,
      note: `Pattern not found in file: "${replacement.from}"`,
    };
  }

  try {
    fs.writeFileSync(filePath, result, 'utf-8');
    return {
      success: true,
      backupPath,
      patchedFile: filePath,
      occurrencesPatched: count,
      note: count > 1 ? `Patched ${count} occurrence(s) of the same locator` : undefined,
    };
  } catch (err) {
    return {
      success: false,
      backupPath,
      patchedFile: filePath,
      occurrencesPatched: 0,
      note: `Write failed: ${(err as Error).message}`,
    };
  }
}

/** Restore a file from its .bak backup */
export function restoreBackup(filePath: string): boolean {
  const backupPath = `${filePath}.bak`;
  if (!fs.existsSync(backupPath)) return false;
  try {
    const original = fs.readFileSync(backupPath, 'utf-8');
    fs.writeFileSync(filePath, original, 'utf-8');
    return true;
  } catch {
    return false;
  }
}

/** Delete a .bak backup after successful verification */
export function deleteBackup(filePath: string): void {
  const backupPath = `${filePath}.bak`;
  try { fs.unlinkSync(backupPath); } catch { /* ignore */ }
}

/** Build a display path for logging */
export function relPath(filePath: string): string {
  return path.relative(process.cwd(), filePath);
}
