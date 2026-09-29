# Playwright AI-Powered Test Framework

A plug-and-play Playwright template with TypeScript, Page Object Model, multi-environment support, Allure reporting, and optional AI features (natural language runner, failure analysis, auto-heal).

---

## Table of Contents

1. [Quick Start](#quick-start)
2. [Project Structure](#project-structure)
3. [Configuration](#configuration)
4. [Writing Tests](#writing-tests)
5. [Running Tests](#running-tests)
6. [Reports](#reports)
7. [AI Features](#ai-features)
8. [Multi-Environment Setup](#multi-environment-setup)
9. [Adding New Pages](#adding-new-pages)
10. [Shared Auth State](#shared-auth-state)
11. [Customisation Checklist](#customisation-checklist)

---

## Quick Start

```bash
# 1 — Install dependencies
npm install
npx playwright install chromium

# 2 — Configure your environment
cp .env.example .env
# Edit .env: set BASE_URL, USERNAME, PASSWORD

# 3 — Run the sample login tests
npx playwright test tests/Login

# 4 — (Optional) Install shell shortcuts
bash scripts/install-shell-commands.sh
source ~/.zshrc   # or ~/.bashrc

# 5 — Use natural language to run tests
pfqa "run login tests"
pfqa "run all tests headed"
pfqa "run login tests on staging"
```

---

## Project Structure

```
template/
├── src/
│   ├── pages/
│   │   └── login.page.ts          # Sample LoginPage (customise selectors)
│   ├── data/
│   │   └── testData.ts            # Sample test data (update for your app)
│   ├── fixtures/
│   │   └── pageObjects.ts         # Extended test fixtures (add your pages here)
│   ├── utils/
│   │   ├── env.ts                 # ENV class — all env vars in one place
│   │   ├── globalSetup.ts         # Loads .env files before tests run
│   │   ├── SafeAction.ts          # Base class: wraps Playwright with auto-wait
│   │   ├── common.ts              # File, alert, frame, network utilities
│   │   ├── chromiumSandbox.ts     # Chromium launch args for CI
│   │   └── playwrightHeadless.ts  # Headless mode resolver
│   ├── ai/
│   │   ├── anthropic-client.ts    # Anthropic / LiteLLM client factory
│   │   ├── nl-runner.ts           # Natural language → Playwright command
│   │   ├── failure-analyzer.ts    # AI failure root-cause analysis
│   │   └── repair-flow.ts         # AI locator repair engine
│   └── reporters/
│       └── heal-reporter.ts       # Custom reporter: tracks failures, triggers heal
├── tests/
│   ├── auth.setup.ts              # Captures auth cookies once; shared by all tests
│   └── Login/
│       └── login.test.ts          # Sample login validation suite
├── scripts/
│   ├── run.ts                     # Natural language runner entry point
│   ├── heal.ts                    # Heal failing tests
│   ├── analyze.ts                 # AI failure analysis CLI
│   ├── repair.ts                  # Manual spec repair CLI
│   └── install-shell-commands.sh  # Install pfqa/run/generate shell commands
├── requirements/
│   ├── TEMPLATE.md                # How to write requirements files
│   └── login.md                   # Sample login requirements
├── helper/
│   └── env/
│       ├── .env.qa.example        # QA env template
│       ├── .env.staging.example   # Staging env template
│       └── .env.prod.example      # Prod env template
├── playwright.config.ts
├── tsconfig.json
├── .env.example                   # Root env template
├── pfqa                           # Bash entry point for natural language runner
└── generate                       # Bash entry point for report generation
```

---

## Configuration

### Environment Variables

Copy `.env.example` to `.env` and update the values:

| Variable          | Description                                  |
|-------------------|----------------------------------------------|
| `BASE_URL`        | Primary app URL (required)                   |
| `BASE_URL_2`      | Secondary URL (admin panel, etc.)            |
| `USERNAME`        | Test user email                              |
| `PASSWORD`        | Test user password                           |
| `ADMIN_USERNAME`  | Admin user email (optional)                  |
| `ADMIN_PASSWORD`  | Admin user password (optional)               |
| `ANTHROPIC_API_KEY` | Required for AI features                   |
| `test_env`        | Active environment: `qa` / `staging` / `prod` |
| `AUTO_HEAL`       | Set to `1` to enable auto-heal (off by default) |

### playwright.config.ts

The config auto-discovers test projects — each subfolder in `tests/` becomes a Playwright project.  
Reporters configured: **Allure** (always) + **HealReporter** (tracks failures for AI).

---

## Writing Tests

### Folder convention
Each feature gets its own folder under `tests/`:

```
tests/
├── Login/
│   └── login.test.ts
├── Dashboard/
│   └── dashboard.test.ts
└── Settings/
    └── settings.test.ts
```

Each folder name auto-registers as a Playwright project.

### Import the extended fixtures

```typescript
import { test, expect } from '../../src/fixtures/pageObjects';

test('login with valid credentials @smoke', async ({ loginPage }) => {
  await loginPage.loginWithCredentials(USERNAME, PASSWORD);
  await loginPage.expectLoginPageNotVisible();
});
```

### Tag your tests

```typescript
test('invalid login shows error @negative @login-invalid', async ({ loginPage }) => { ... });
```

Run by tag: `npx playwright test --grep @smoke`

### Test data

Edit `src/data/testData.ts` to add your own test users and expected messages.

---

## Running Tests

### Direct Playwright commands

```bash
npx playwright test                          # all tests
npx playwright test tests/Login             # one folder
npx playwright test --grep @smoke           # by tag
npx playwright test --headed               # with browser visible
test_env=staging npx playwright test        # specific environment
npx playwright test --ui                    # Playwright UI Studio
```

### Playwright UI Studio

The interactive UI Studio lets you run, debug, and record tests visually:

```bash
# Single command — any of these work:
npm run studio
pfqa "open studio"
pfqa "launch ui"
pfqa "studio"
```

Studio opens in your browser. From there you can:
- Run individual tests with one click
- Watch test execution step-by-step
- Use the **Pick locator** tool to generate selectors
- Record new test interactions
- Time-travel through screenshots for each step

### Natural language (pfqa)

After installing shell commands (`bash scripts/install-shell-commands.sh`):

```bash
pfqa "run login tests"
pfqa "run login tests headed"
pfqa "run all tests on staging"
pfqa "run smoke tests"
pfqa "run failed tests again"
pfqa "open studio"
pfqa "what tests are available"
```

---

## Reports

### Generate and view Allure report

```bash
./generate                      # build report → allure-report-share/index.html
./generate open                 # build + open in browser
npm run report:share            # same via npm script
```

The generated `allure-report-share/index.html` is a **single self-contained file** — share it by email or Slack without any server.

### pfqa shortcut

```bash
pfqa "show report"
pfqa "open report"
```

---

## AI Features

All AI features require `ANTHROPIC_API_KEY` set in `.env`.

### Natural Language Runner

```bash
pfqa "run login tests headed"
pfqa "run all tests on staging"
pfqa "run smoke tests"
```

### Failure Analysis

```bash
pfqa "analyze failures"
npx tsx scripts/analyze.ts --run   # runs tests then analyzes
```

Prints root cause, category, severity, and suggested fix for each failure.

### Auto-Heal

```bash
pfqa "heal"                              # heal last-failed specs
pfqa "heal" tests/Login/login.test.ts   # heal specific spec
AUTO_HEAL=1 npx playwright test         # enable during a run
```

Auto-heal re-runs the failing spec with `AUTO_HEAL=1`, which activates the `HealReporter`. On failure, it calls the AI repair engine to patch broken locators in POM files.

### Manual Repair

```bash
npx tsx scripts/repair.ts \
  --spec tests/Login/login.test.ts \
  --url  https://yourapp.example.com \
  --pom  src/pages/login.page.ts \
  --headed
```

### LiteLLM Proxy (Alternative to Direct API Key)

If your org uses a LiteLLM proxy:

```env
LITELLM_BASE_URL=http://localhost:4000
LITELLM_API_KEY=your-litellm-key
```

When both `LITELLM_BASE_URL` and `LITELLM_API_KEY` are set, the framework routes through the proxy instead of calling Anthropic directly.

---

## Multi-Environment Setup

```
helper/env/
├── .env.qa          ← copy from .env.qa.example, fill in QA values
├── .env.staging     ← copy from .env.staging.example
└── .env.prod        ← copy from .env.prod.example
```

Switch environments:

```bash
test_env=staging npx playwright test
pfqa "run login tests on staging"
pfqa "run smoke tests on prod"
```

`globalSetup` loads `helper/env/.env.<test_env>` before tests run; if the file doesn't exist it falls back to the root `.env`.

---

## Adding New Pages

**1 — Create the Page Object**

```typescript
// src/pages/dashboard.page.ts
import { SafeAction } from '../utils/SafeAction';

export class DashboardPage extends SafeAction {
  async expectWelcomeBanner() {
    await this.isVisible(this.page.locator('[data-testid="welcome-banner"]'));
  }
}
```

**2 — Register the fixture**

```typescript
// src/fixtures/pageObjects.ts  — add to the existing extend block
import { DashboardPage } from '../pages/dashboard.page';

export const test = base.extend<Fixtures>({
  // ... existing fixtures ...
  dashboardPage: async ({ page }, use) => use(new DashboardPage(page)),
});
```

**3 — Write tests**

```typescript
// tests/Dashboard/dashboard.test.ts
import { test, expect } from '../../src/fixtures/pageObjects';

test('welcome banner is shown after login @smoke', async ({ dashboardPage }) => {
  await dashboardPage.expectWelcomeBanner();
});
```

**4 — Register the folder phrase** (optional, for natural language runner)

```typescript
// src/ai/nl-runner.ts — add to FOLDER_PHRASES
'Dashboard': ['dashboard', 'home', 'main page'],
```

---

## Shared Auth State

`tests/auth.setup.ts` logs in once and saves cookies to `storageState-merged.json`.  
All tests in the suite reuse this state — no repeated logins needed.

To add a second session (e.g., admin user):

```typescript
// auth.setup.ts — duplicate the block for adminPage and save to storageState-admin.json
```

Then reference it in `playwright.config.ts` under `use.storageState`.

---

## Customisation Checklist

After cloning this template, work through these steps:

- [ ] **`src/pages/login.page.ts`** — update `emailInput`, `passwordInput`, `submitButton` selectors to match your app
- [ ] **`tests/auth.setup.ts`** — verify `waitForAuthSuccess()` method matches your app's post-login URL or element
- [ ] **`src/data/testData.ts`** — replace `validUser`, `invalidUser` with real test accounts
- [ ] **`.env`** — set `BASE_URL`, `USERNAME`, `PASSWORD`
- [ ] **`helper/env/.env.qa`** — copy from `.env.qa.example` and set QA values
- [ ] **`src/ai/nl-runner.ts`** — add your feature folder names to `FOLDER_PHRASES`
- [ ] **`requirements/`** — add a `.md` file for each feature (follow `TEMPLATE.md`)
- [ ] Run `bash scripts/install-shell-commands.sh` for `pfqa` global command

---

## npm Scripts

```bash
npm test                          # run all tests
npm run test:headed               # run with browser visible
npm run studio                    # open Playwright UI Studio
npm run report:generate           # generate Allure HTML report
npm run report:share              # generate single-file shareable report
npm run report:open               # open report in browser
npm run analyze                   # AI failure analysis
npm run heal                      # heal failing tests
npm run install:shell             # install pfqa / run / generate commands
```

---

## Requirements

- Node.js 18+ (Node 22 recommended — see `.nvmrc`)
- Chromium (installed via `npx playwright install chromium`)
- Anthropic API key (only for AI features)
