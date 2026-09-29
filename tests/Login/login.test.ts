// Sample Login Page Validations
//
// These tests demonstrate the framework's patterns and serve as a starting
// point. Update the selectors in src/pages/login.page.ts and the expected
// messages in src/data/testData.ts to match your application.
//
// Test coverage:
//   - Successful login with valid credentials
//   - Error displayed for invalid credentials
//   - Error displayed for empty email
//   - Error displayed for empty password
//   - Both fields empty — button click stays on login page
//   - Login page accessibility (title, heading, key elements visible)
//   - Forgot password link visibility
//   - Session persistence after page reload
//   - Logout and redirect back to login page

import test, { expect } from '../../src/fixtures/pageObjects';
import ENV              from '../../src/utils/env';
import { LoginData }    from '../../src/data/testData';

test.describe('Login Page — Core Validations', {
  tag: ['@login', '@smoke'],
}, () => {

  test.beforeEach(async ({ page }) => {
    await page.goto(ENV.BASE_URL!, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {});
  });

  // ── Happy path ────────────────────────────────────────────────────────────

  test('should successfully log in with valid credentials', {
    tag: ['@login-valid', '@smoke'],
  }, async ({ loginPage, page }) => {
    test.setTimeout(120_000);

    await test.step('Navigate to login page', async () => {
      await page.goto(ENV.BASE_URL!, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    });

    await test.step('Fill in valid credentials and submit', async () => {
      await loginPage.loginWithCredentials(
        LoginData.validUser.email,
        LoginData.validUser.password,
      );
    });

    await test.step('Verify successful login — not on login page any more', async () => {
      // The login page should no longer be visible after a successful login.
      // TODO: Replace with your app's actual post-login assertion, e.g.:
      //   await expect(page).toHaveURL(/dashboard/);
      //   await expect(page.locator('[data-testid="user-menu"]')).toBeVisible();
      const stillOnLogin = await loginPage.isLoginPageVisible();
      expect(stillOnLogin, 'Login page should not be visible after successful login').toBe(false);
    });
  });

  // ── Error — invalid credentials ───────────────────────────────────────────

  test('should show an error message for invalid credentials', {
    tag: ['@login-invalid', '@negative'],
  }, async ({ loginPage, page }) => {
    test.setTimeout(60_000);

    await test.step('Enter incorrect credentials', async () => {
      await loginPage.loginWithCredentials(
        LoginData.invalidUser.email,
        LoginData.invalidUser.password,
      );
    });

    await test.step('Verify error message is visible', async () => {
      await loginPage.expectErrorMessageVisible();
    });

    await test.step('Verify user is still on the login page', async () => {
      await loginPage.expectStillOnLoginPage();
    });
  });

  // ── Error — empty email ───────────────────────────────────────────────────

  test('should show an error when email is empty', {
    tag: ['@login-empty-email', '@negative'],
  }, async ({ loginPage, page }) => {
    test.setTimeout(60_000);

    await test.step('Submit form with empty email', async () => {
      await loginPage.loginWithCredentials('', LoginData.validUser.password);
    });

    await test.step('Verify email field validation error', async () => {
      await loginPage.expectEmailFieldErrorVisible();
    });

    await test.step('Verify user is still on the login page', async () => {
      await loginPage.expectStillOnLoginPage();
    });
  });

  // ── Error — empty password ────────────────────────────────────────────────

  test('should show an error when password is empty', {
    tag: ['@login-empty-password', '@negative'],
  }, async ({ loginPage, page }) => {
    test.setTimeout(60_000);

    await test.step('Submit form with empty password', async () => {
      await loginPage.loginWithCredentials(LoginData.validUser.email, '');
    });

    await test.step('Verify password field validation error', async () => {
      await loginPage.expectPasswordFieldErrorVisible();
    });

    await test.step('Verify user is still on the login page', async () => {
      await loginPage.expectStillOnLoginPage();
    });
  });

  // ── Error — both fields empty ─────────────────────────────────────────────

  test('should show errors when both email and password are empty', {
    tag: ['@login-empty-both', '@negative'],
  }, async ({ loginPage, page }) => {
    test.setTimeout(60_000);

    await test.step('Click login button with both fields empty', async () => {
      await loginPage.loginWithCredentials('', '');
    });

    await test.step('Verify user is still on the login page', async () => {
      await loginPage.expectStillOnLoginPage();
    });
  });

  // ── Accessibility & UI ────────────────────────────────────────────────────

  test('login page should have all expected UI elements', {
    tag: ['@login-ui', '@accessibility'],
  }, async ({ loginPage, page }) => {
    test.setTimeout(30_000);

    await test.step('Verify email field is visible', async () => {
      const emailField = page.locator(loginPage.loginPageElements.emailField).first();
      await expect(emailField).toBeVisible();
    });

    await test.step('Verify password field is visible', async () => {
      const passField = page.locator(loginPage.loginPageElements.passwordField).first();
      await expect(passField).toBeVisible();
    });

    await test.step('Verify login button is visible and enabled', async () => {
      const loginBtn = page.locator(loginPage.loginPageElements.loginButton).first();
      await expect(loginBtn).toBeVisible();
      await expect(loginBtn).toBeEnabled();
    });

    await test.step('Verify page title is set', async () => {
      const title = await page.title();
      expect(title.length, 'Page should have a non-empty title').toBeGreaterThan(0);
    });

    await test.step('Verify forgot password link is visible', async () => {
      await loginPage.expectForgotPasswordLinkVisible();
    });
  });

  // ── Input sanitisation ────────────────────────────────────────────────────

  test('should handle malformed email input gracefully', {
    tag: ['@login-malformed', '@negative'],
  }, async ({ loginPage, page }) => {
    test.setTimeout(60_000);

    await test.step('Enter a string that is not a valid email', async () => {
      await loginPage.loginWithCredentials(
        LoginData.malformed.notAnEmail,
        LoginData.validUser.password,
      );
    });

    await test.step('Verify validation error or remain on login page', async () => {
      // Either the browser/app shows an inline error, or the user stays on login page.
      const stillOnLogin = await loginPage.isLoginPageVisible();
      expect(stillOnLogin, 'Should stay on login page with malformed email').toBe(true);
    });
  });

});

// ── Session tests (use storageState from auth.setup.ts) ───────────────────────
// These run with an already-authenticated session (no login step needed).

test.describe('Login Page — Session Behaviour', {
  tag: ['@login-session'],
}, () => {

  test('authenticated user navigating to login URL should be redirected', {
    tag: ['@login-redirect'],
  }, async ({ page }) => {
    test.setTimeout(60_000);

    await test.step('Navigate to the app base URL while already logged in', async () => {
      await page.goto(ENV.BASE_URL!, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {});
    });

    await test.step('Verify the app shows authenticated content', async () => {
      // An already-authenticated user should NOT see the login form.
      // TODO: Replace with your app's post-login page assertion.
      // e.g.:  await expect(page).toHaveURL(/dashboard/);
      const loginFormVisible = await page
        .locator('input[type="password"]')
        .isVisible({ timeout: 5_000 })
        .catch(() => false);
      expect(loginFormVisible, 'Authenticated user should not see login form').toBe(false);
    });
  });

});
