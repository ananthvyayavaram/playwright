import { Page, Locator } from "@playwright/test";

const DEFAULT_TIMEOUT = 60_000;

// Base class that wraps Playwright actions with automatic visibility waits.
// Extend your page objects from this instead of using raw Playwright calls
// to get consistent timeout handling across the board.
export class SafeAction {
  constructor(protected page: Page) {}

  async safeClick(locator: Locator, timeout = DEFAULT_TIMEOUT): Promise<void> {
    await locator.waitFor({ state: "visible", timeout });
    await locator.click();
  }

  async safeDoubleClick(locator: Locator, timeout = DEFAULT_TIMEOUT): Promise<void> {
    await locator.waitFor({ state: "visible", timeout });
    await locator.dblclick();
  }

  async safeFill(locator: Locator, value: string, timeout = DEFAULT_TIMEOUT): Promise<void> {
    await locator.waitFor({ state: "visible", timeout });
    await locator.clear();
    await locator.fill(value);
  }

  async safeType(locator: Locator, value: string, timeout = DEFAULT_TIMEOUT): Promise<void> {
    await locator.waitFor({ state: "visible", timeout });
    await locator.pressSequentially(value);
  }

  async safeSelectOption(locator: Locator, value: string, timeout = DEFAULT_TIMEOUT): Promise<void> {
    await locator.waitFor({ state: "visible", timeout });
    await locator.selectOption(value);
  }

  async safeHover(locator: Locator, timeout = DEFAULT_TIMEOUT): Promise<void> {
    await locator.waitFor({ state: "visible", timeout });
    await locator.hover();
  }

  async safeCheck(locator: Locator, timeout = DEFAULT_TIMEOUT): Promise<void> {
    await locator.waitFor({ state: "visible", timeout });
    await locator.check();
  }

  async safeUncheck(locator: Locator, timeout = DEFAULT_TIMEOUT): Promise<void> {
    await locator.waitFor({ state: "visible", timeout });
    await locator.uncheck();
  }

  async safeGetText(locator: Locator, timeout = DEFAULT_TIMEOUT): Promise<string> {
    await locator.waitFor({ state: "visible", timeout });
    return locator.innerText();
  }

  async safeGetAttribute(locator: Locator, attr: string, timeout = DEFAULT_TIMEOUT): Promise<string | null> {
    await locator.waitFor({ state: "attached", timeout });
    return locator.getAttribute(attr);
  }

  async safeIsVisible(locator: Locator, timeout = DEFAULT_TIMEOUT): Promise<boolean> {
    try {
      await locator.waitFor({ state: "visible", timeout });
      return true;
    } catch {
      return false;
    }
  }

  async safeScrollIntoView(locator: Locator, timeout = DEFAULT_TIMEOUT): Promise<void> {
    await locator.waitFor({ state: "attached", timeout });
    await locator.scrollIntoViewIfNeeded();
  }

  async safeUploadFile(locator: Locator, filePath: string | string[], timeout = DEFAULT_TIMEOUT): Promise<void> {
    await locator.waitFor({ state: "attached", timeout });
    await locator.setInputFiles(filePath);
  }
}
