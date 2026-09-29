/**
 * Opens a minimal Playwright browser, navigates to the target URL,
 * and extracts all interactive elements in a SINGLE DOM evaluation.
 *
 * No agent loop. No LLM. One browser open → one page.evaluate → close.
 * If storageState.json exists, it is used for authenticated pages.
 *
 * Returns a list of PageElements that the confidence scorer can rank.
 */
import { chromium } from 'playwright';
import { existsSync } from 'fs';
import path from 'path';
import type { PageElement } from './types';

/** Selector that captures all meaningful interactive elements */
const INTERACTIVE_SELECTOR = [
  'button', 'a[href]', 'input', 'select', 'textarea',
  '[role="button"]', '[role="link"]', '[role="combobox"]',
  '[role="checkbox"]', '[role="menuitem"]', '[role="option"]',
  '[role="tab"]', '[role="switch"]', '[role="radio"]',
  '[data-testid]', '[aria-label]', '[type="submit"]',
].join(',');

interface RawElement {
  tag: string;
  id: string;
  text: string;
  role: string;
  testId: string;
  ariaLabel: string;
  name: string;
  placeholder: string;
  type: string;
  href: string;
  visible: boolean;
  enabled: boolean;
}

/**
 * Fetch all interactive elements from the live page.
 * Uses storageState.json for authentication when available.
 *
 * @param url  The URL to navigate to
 * @param storageStatePath  Path to Playwright storage state JSON (optional)
 * @param timeoutMs  Navigation timeout in ms (default 30s)
 */
export async function fetchPageElements(
  url: string,
  storageStatePath = 'storageState.json',
  timeoutMs = 30_000,
): Promise<PageElement[]> {
  const absStorageState = path.isAbsolute(storageStatePath)
    ? storageStatePath
    : path.resolve(process.cwd(), storageStatePath);

  const useStorageState = existsSync(absStorageState);

  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  try {
    const context = await browser.newContext(
      useStorageState ? { storageState: absStorageState } : {},
    );
    const page = await context.newPage();

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    // Brief wait for any async rendering
    await page.waitForTimeout(800);

    // Detect if we landed on a login page instead of the target — auth may have expired
    const currentUrl = page.url();
    const onLoginPage = /login|signin|auth/i.test(currentUrl) && !(/login|signin|auth/i.test(url));
    if (onLoginPage) {
      // Cannot inspect authenticated content without valid session
      return [];
    }

    const rawElements: RawElement[] = await page.evaluate((selector: string) => {
      function getText(el: Element): string {
        return (el.textContent ?? '').trim().replace(/\s+/g, ' ').substring(0, 80);
      }
      function isVisible(el: Element): boolean {
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      }
      return Array.from(document.querySelectorAll(selector)).slice(0, 200).map((el, index) => ({
        tag: el.tagName.toLowerCase(),
        id: (el as HTMLElement).id ?? '',
        text: getText(el),
        role: el.getAttribute('role') ?? el.tagName.toLowerCase(),
        testId: el.getAttribute('data-testid') ?? el.getAttribute('data-qa-hook') ?? '',
        ariaLabel: el.getAttribute('aria-label') ?? el.getAttribute('aria-labelledby') ?? '',
        name: (el as HTMLInputElement).name ?? '',
        placeholder: (el as HTMLInputElement).placeholder ?? '',
        type: (el as HTMLInputElement).type ?? '',
        href: (el as HTMLAnchorElement).href ?? '',
        visible: isVisible(el),
        enabled: !(el as HTMLButtonElement).disabled,
        index,
      }));
    }, INTERACTIVE_SELECTOR);

    return rawElements.map((r, i) => ({
      tag: r.tag,
      id: r.id || undefined,
      text: r.text || undefined,
      role: r.role || undefined,
      testId: r.testId || undefined,
      ariaLabel: r.ariaLabel || undefined,
      name: r.name || undefined,
      placeholder: r.placeholder || undefined,
      type: r.type || undefined,
      href: r.href || undefined,
      visible: r.visible,
      enabled: r.enabled,
      index: i,
    }));
  } finally {
    await browser.close().catch(() => null);
  }
}

/**
 * Try each URL candidate to find one that returns elements.
 * Used when the exact URL at failure time is uncertain.
 */
export async function fetchPageElementsWithFallback(
  urls: string[],
  storageStatePath?: string,
  timeoutMs = 30_000,
): Promise<{ elements: PageElement[]; resolvedUrl: string } | null> {
  for (const url of urls) {
    try {
      const elements = await fetchPageElements(url, storageStatePath, timeoutMs);
      if (elements.length > 0) return { elements, resolvedUrl: url };
    } catch {
      // Try next URL
    }
  }
  return null;
}
