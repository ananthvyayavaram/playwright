// Playwright globalSetup — loads the correct .env file (qa/staging/prod) from
// helper/env/ before any test runs, and wipes stale Allure artifacts.
import { FullConfig } from '@playwright/test';
import { rmSync, mkdirSync, writeFileSync } from 'fs';
import path from 'path';
import dotenv from 'dotenv';

export const RUN_MARKER_FILE = 'allure-results/.run-info.json';

function resolveTestEnv(): string {
  const raw = process.env.test_env ?? process.env.TEST_ENV ?? '';
  const s   = String(raw).trim().toLowerCase();
  if (!s || s === 'undefined' || s === 'null') return 'qa';
  return s;
}

function cleanAllureArtifacts(testEnv: string) {
  const root    = process.cwd();
  const results = path.join(root, 'allure-results');
  const report  = path.join(root, 'allure-report');
  try {
    rmSync(results, { recursive: true, force: true });
    mkdirSync(results, { recursive: true });
    rmSync(report,  { recursive: true, force: true });
    writeFileSync(
      path.join(root, RUN_MARKER_FILE),
      JSON.stringify({ startedAt: new Date().toISOString(), env: testEnv }, null, 2),
    );
  } catch {
    // non-fatal
  }
}

export default async function globalSetup(_config: FullConfig) {
  const testEnv = resolveTestEnv();
  process.env.test_env = testEnv;
  process.env.TEST_ENV = testEnv;

  // Load env file from helper/env/.env.<environment>
  // If the file doesn't exist, fall back to .env at the project root.
  const envFilePath = `helper/env/.env.${testEnv}`;
  const result = dotenv.config({ path: envFilePath, override: true });
  if (result.error) {
    dotenv.config({ override: true });
  }

  cleanAllureArtifacts(testEnv);
}
