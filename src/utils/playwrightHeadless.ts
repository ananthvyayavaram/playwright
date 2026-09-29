// Controls headless mode.
// PW_HEADLESS=1  → headless (CI default)
// PW_HEADED=1    → headed (see the browser)
// Default when neither is set: headed locally, headless in CI (via PW_HEADLESS=1 in npm scripts)
export function playwrightUseHeadless(): boolean {
  if (/^(1|true|yes)$/i.test(String(process.env.PW_HEADLESS || ''))) return true;
  if (/^(0|false|no)$/i.test(String(process.env.PW_HEADED  || ''))) return true;
  return false;
}
