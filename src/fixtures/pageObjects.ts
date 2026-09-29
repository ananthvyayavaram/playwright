// Extends Playwright test with page object fixtures.
// Import `test` from this file in every test — NOT from @playwright/test directly.
//
// HOW TO ADD A NEW PAGE:
//   1. Create your page class in src/pages/myFeature.page.ts
//   2. Import it here.
//   3. Add it to the extend<{}> type and the fixture map below.
//   4. Use it in tests: async ({ myFeaturePage }) => { ... }

import { test as baseTest, type Page } from '@playwright/test';
import LoginPage from '../pages/login.page';
import Common    from '../utils/common';

// Wraps page.goto with a single automatic retry on ERR_ABORTED.
// SPAs and service-worker-driven apps frequently abort the first navigation
// while their client-side router initialises; the retry lands correctly.
function patchGoto(page: Page): void {
  const orig = page.goto.bind(page);
  (page as any).goto = async (url: string, options?: Parameters<Page['goto']>[1]) => {
    try {
      return await orig(url, options);
    } catch (err) {
      if (!String(err).includes('ERR_ABORTED')) throw err;
      await page.waitForTimeout(1000);
      return await orig(url, options);
    }
  };
}

const test = baseTest.extend<{
  loginPage: LoginPage;
  common:    Common;
  // Add more fixtures here as you create new page objects:
  // myFeaturePage: MyFeaturePage;
}>({
  page: async ({ page }, use) => {
    patchGoto(page);
    await use(page);
  },
  loginPage: async ({ page }, use) => { await use(new LoginPage(page)); },
  common:    async ({ page }, use) => { await use(new Common(page));    },
  // myFeaturePage: async ({ page }, use) => { await use(new MyFeaturePage(page)); },
});

export default test;
export { expect } from '@playwright/test';
