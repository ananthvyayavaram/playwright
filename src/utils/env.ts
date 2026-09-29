// Static ENV class — all environment variables in one place.
// Add your own URL/credential getters here as you expand the framework.
// Values are loaded from helper/env/.env.<env> by globalSetup before any test runs.

export default class ENV {

  // ── Application URLs ──────────────────────────────────────────────────────

  /** Primary application URL (required) */
  public static get BASE_URL() {
    return process.env.BASE_URL;
  }

  /** Additional URL — add more as needed (BASE_URL_ADMIN, BASE_URL_API, etc.) */
  public static get BASE_URL_2() {
    return process.env.BASE_URL_2;
  }

  // ── Credentials ───────────────────────────────────────────────────────────

  /** Primary test user email / username */
  public static get USERNAME() {
    return process.env.USERNAME;
  }

  /** Primary test user password */
  public static get PASSWORD() {
    return process.env.PASSWORD;
  }

  /** Secondary user credentials (e.g. admin role, read-only role) */
  public static get ADMIN_USERNAME() {
    return process.env.ADMIN_USERNAME;
  }

  public static get ADMIN_PASSWORD() {
    return process.env.ADMIN_PASSWORD;
  }

  // ── Misc ──────────────────────────────────────────────────────────────────

  /** Active environment: qa | staging | prod */
  public static get TEST_ENV() {
    return process.env.test_env ?? 'qa';
  }
}
