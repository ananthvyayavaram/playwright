// Global auth setup — logs into every BASE_URL* domain in parallel and writes
// a single merged storageState file so tests skip the login step entirely.
//
// HOW IT WORKS:
//   1. Reads every BASE_URL* env var that starts with "http".
//   2. Launches one isolated browser context per URL.
//   3. Logs in and captures cookies.
//   4. Merges all cookies into storageState-merged.json.
//   5. playwright.config.ts injects that file as storageState for every project.
//
// HOW TO CUSTOMIZE:
//   Update loginAndGetCookies() to match your app's login flow.
//   The selectors and waitForResponse() below must match your app.
//
import ENV from '../src/utils/env';
import { playwrightChromiumLaunchArgs } from '../src/utils/chromiumSandbox';
import { playwrightUseHeadless }        from '../src/utils/playwrightHeadless';
import { chromium }                     from '@playwright/test';
import { writeFileSync }                from 'fs';
import LoginPage                        from '../src/pages/login.page';

type Cookie = { name: string; domain: string; path: string; [key: string]: unknown };

function dedupe(cookies: Cookie[]): Cookie[] {
  const seen = new Map<string, Cookie>();
  for (const c of cookies) seen.set(`${c.name}||${c.domain}||${c.path}`, c);
  return [...seen.values()];
}

async function loginAndGetCookies(
  page: import('@playwright/test').Page,
  url:  string,
  user: string,
  pass: string,
): Promise<Cookie[]> {
  const loginPage = new LoginPage(page);
  await loginPage.loginToApplication(url, user, pass);

  // Wait for all post-login XHR/fetch calls to complete so tokens and session
  // cookies are captured in the storage state.
  await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {});
  const state = await page.context().storageState();
  return state.cookies as Cookie[];
}

export default async function authSetup() {
  const targets: Array<{ url: string }> = [];
  for (const [envVar, val] of Object.entries(process.env)) {
    if (!val || !val.startsWith('http')) continue;
    if (envVar === 'BASE_URL') {
      targets.unshift({ url: val });
    } else if (envVar.startsWith('BASE_URL_')) {
      targets.push({ url: val });
    }
  }

  if (!targets.length) {
    console.warn('[auth-setup] No BASE_URL* env vars found — skipping auth setup.');
    return;
  }

  const headless = playwrightUseHeadless();
  const browser  = await chromium.launch({
    headless,
    channel: 'chrome',
    args: playwrightChromiumLaunchArgs([
      '--window-size=1920,1080',
      '--force-device-scale-factor=1',
    ]),
  });

  const results = await Promise.all(
    targets.map(async ({ url }) => {
      const ctx  = await browser.newContext();
      const page = await ctx.newPage();
      try {
        return await loginAndGetCookies(page, url, ENV.USERNAME!, ENV.PASSWORD!);
      } catch (err) {
        console.warn(`[auth-setup] Login failed for ${url}: ${err}`);
        return [] as Cookie[];
      } finally {
        await ctx.close();
      }
    }),
  );

  await browser.close();

  const allCookies = dedupe(results.flat());
  if (allCookies.length) {
    writeFileSync(
      'storageState-merged.json',
      JSON.stringify({ cookies: allCookies, origins: [] }, null, 2),
    );
    console.log(`[auth-setup] Saved ${allCookies.length} cookie(s) to storageState-merged.json`);
  }
}
