// Central Playwright config — auto-discovers test folders, sets timeouts, reporters (Allure + AI heal), and auth.
//
// Projects are built automatically by scanning each tests/ subdirectory.
// Adding a new test folder requires ZERO changes here.
import { cpus } from 'node:os';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { defineConfig, type Project } from '@playwright/test';
import { playwrightChromiumLaunchArgs } from './src/utils/chromiumSandbox';
import { playwrightUseHeadless } from './src/utils/playwrightHeadless';

const headless      = playwrightUseHeadless();
const workers       = Math.min(5, Math.max(1, cpus().length));
const authMode      = (process.env.PFQA_AUTH_MODE ?? 'shared').toLowerCase();
const useSharedAuth = authMode !== 'isolated';

function storageStateForFolder(_folderPath: string): string | undefined {
  if (!useSharedAuth) return undefined;
  const name = 'storageState-merged.json';
  return existsSync(name) ? name : undefined;
}

// Headed: maximise to actual screen so tests aren't clipped.
// Headless: fixed 1920×1080 virtual viewport.
const windowArgs    = headless ? [] : ['--start-maximized'];
const viewportConfig = headless
  ? { viewport: { width: 1920, height: 1080 } as const }
  : { viewport: null };

const sharedUse = {
  headless,
  navigationTimeout: 120_000,
  actionTimeout:      90_000,
  screenshot:        'only-on-failure' as const,
  video:             'on-first-retry' as const,
  trace:             'on-first-retry' as const,
  ...viewportConfig,
  channel:           'chrome' as const,
  launchOptions: {
    slowMo: parseInt(process.env.SLOW_MO ?? (headless ? '1000' : '500')),
    args: playwrightChromiumLaunchArgs([
      '--autoplay-policy=no-user-gesture-required',
      ...windowArgs,
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--force-device-scale-factor=1',
    ]),
  },
};

function buildProjects(): Project[] {
  const testsDir = join(__dirname, 'tests');
  let subdirs: string[] = [];
  try {
    subdirs = readdirSync(testsDir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);
  } catch { /* tests dir missing */ }

  return subdirs.map(dir => {
    const folderPath = join(testsDir, dir);
    const storage    = storageStateForFolder(folderPath);
    return {
      name:      dir.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
      testMatch: [
        `tests/${dir}/**/*.test.ts`,
        `tests/${dir}/**/*.spec.ts`,
      ],
      use: { ...sharedUse, storageState: storage },
    };
  });
}

export default defineConfig({
  testDir: './tests',

  timeout:       300_000,
  fullyParallel: true,
  forbidOnly:    !!process.env.CI,
  retries:       1,
  workers:       process.env.CI ? 1 : workers,

  reporter: [
    ['list'],
    ['allure-playwright'],
    // AI auto-heal: only activates when AUTO_HEAL=1 (i.e. via pfqa heal command).
    ['./src/reporters/heal-reporter.ts', {
      headed:      process.env.PW_HEADED === '1',
      maxAttempts: 3,
      model:       'claude-sonnet-5',
      analyze:     true,
      verify:      true,
    }],
  ],

  use: sharedUse,

  projects: buildProjects(),

  globalSetup: useSharedAuth
    ? ['src/utils/globalSetup.ts', './tests/auth.setup.ts']
    : 'src/utils/globalSetup.ts',

  outputDir: 'test-results',
});
