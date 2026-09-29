// Generic Login Page Object.
//
// HOW TO ADAPT THIS FOR YOUR APP:
//   1. Update loginPageElements selectors to match your app's login form.
//   2. Update the waitForAuthSuccess() call in loginToApplication() to match
//      your app's post-login network call or URL pattern.
//   3. If your app uses SSO/OAuth, add an ssoLogin() method below.
//
import { Page, expect } from "@playwright/test";
import ENV from "../utils/env";

export default class LoginPage {
  constructor(public page: Page) {}

  // ── Selectors ─────────────────────────────────────────────────────────────
  // TODO: Replace these with the actual selectors from your application's login page.

  public loginPageElements = {
    emailField:       `input[type="email"], input[name="email"], input[placeholder*="email" i], input[placeholder*="username" i]`,
    passwordField:    `input[type="password"]`,
    loginButton:      `button[type="submit"], input[type="submit"], button:has-text("Log in"), button:has-text("Sign in")`,
    errorMessage:     `[data-testid="error"], .error-message, .alert-danger, [role="alert"]`,
    emailErrorMsg:    `[data-testid="email-error"], .email-error, input[name="email"] ~ .error`,
    passwordErrorMsg: `[data-testid="password-error"], .password-error, input[type="password"] ~ .error`,
    forgotPassword:   `a:has-text("Forgot"), a:has-text("Reset password")`,
    signUpLink:       `a:has-text("Sign up"), a:has-text("Create account"), a:has-text("Register")`,
    rememberMe:       `input[type="checkbox"][name*="remember" i]`,
  };

  // ── Core login action ─────────────────────────────────────────────────────

  public async loginToApplication(url?: string, username?: string, password?: string) {
    const target = url      ?? ENV.BASE_URL!;
    const user   = username ?? ENV.USERNAME!;
    const pass   = password ?? ENV.PASSWORD!;

    await this.page.goto(target, { waitUntil: 'domcontentloaded', timeout: 120_000 });
    await this.page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {});

    const emailField = this.page.locator(this.loginPageElements.emailField).first();
    const requiresLogin = await emailField.isVisible({ timeout: 5_000 }).catch(() => false);

    if (requiresLogin) {
      await emailField.fill(user);
      await this.page.locator(this.loginPageElements.passwordField).first().fill(pass);
      await this.page.locator(this.loginPageElements.loginButton).first().click();

      // TODO: Replace with your app's actual post-login indicator —
      // a network response pattern, a URL change, or a dashboard element.
      await this.waitForAuthSuccess();
    }
  }

  // ── Validation helpers ────────────────────────────────────────────────────

  public async loginWithCredentials(username: string, password: string) {
    const emailField = this.page.locator(this.loginPageElements.emailField).first();
    await emailField.waitFor({ state: 'visible', timeout: 30_000 });
    await emailField.fill(username);
    await this.page.locator(this.loginPageElements.passwordField).first().fill(password);
    await this.page.locator(this.loginPageElements.loginButton).first().click();
  }

  public async expectErrorMessageVisible(expectedText?: string) {
    const errorLocator = this.page.locator(this.loginPageElements.errorMessage).first();
    await expect(errorLocator).toBeVisible({ timeout: 10_000 });
    if (expectedText) {
      await expect(errorLocator).toContainText(expectedText);
    }
  }

  public async expectEmailFieldErrorVisible() {
    const emailError = this.page.locator(this.loginPageElements.emailErrorMsg).first();
    // Fall back to required validation on the field itself if no separate error element.
    const emailField = this.page.locator(this.loginPageElements.emailField).first();
    const hasErrorEl = await emailError.isVisible({ timeout: 3_000 }).catch(() => false);
    if (hasErrorEl) {
      await expect(emailError).toBeVisible();
    } else {
      await expect(emailField).toHaveAttribute('aria-invalid', 'true');
    }
  }

  public async expectPasswordFieldErrorVisible() {
    const passError = this.page.locator(this.loginPageElements.passwordErrorMsg).first();
    const passField = this.page.locator(this.loginPageElements.passwordField).first();
    const hasErrorEl = await passError.isVisible({ timeout: 3_000 }).catch(() => false);
    if (hasErrorEl) {
      await expect(passError).toBeVisible();
    } else {
      await expect(passField).toHaveAttribute('aria-invalid', 'true');
    }
  }

  public async expectStillOnLoginPage() {
    await expect(this.page.locator(this.loginPageElements.emailField).first())
      .toBeVisible({ timeout: 5_000 });
  }

  public async expectForgotPasswordLinkVisible() {
    await expect(this.page.locator(this.loginPageElements.forgotPassword).first())
      .toBeVisible({ timeout: 5_000 });
  }

  public async isLoginPageVisible(): Promise<boolean> {
    return this.page.locator(this.loginPageElements.emailField).first()
      .isVisible({ timeout: 5_000 }).catch(() => false);
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private async waitForAuthSuccess() {
    // TODO: Replace with the real post-login signal for your app.
    // Option A: wait for a dashboard URL
    //   await this.page.waitForURL('**/dashboard**', { timeout: 60_000 });
    // Option B: wait for a specific API response
    //   await this.page.waitForResponse(resp => resp.url().includes('/api/me') && resp.status() === 200, { timeout: 60_000 });
    // Option C: wait for a specific element
    //   await this.page.locator('[data-testid="user-menu"]').waitFor({ state: 'visible', timeout: 60_000 });

    // Default: wait for network idle after login
    await this.page.waitForLoadState('networkidle', { timeout: 60_000 }).catch(() => {});
  }
}
