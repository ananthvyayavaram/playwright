// Returns Chromium launch args — disables OS sandbox by default (required in CI/Docker).
// Opt back in with PLAYWRIGHT_FORCE_SANDBOX=1.
export function useChromiumOsSandbox(): boolean {
  return /^(1|true|yes)$/i.test(String(process.env.PLAYWRIGHT_FORCE_SANDBOX || ''));
}

export function chromiumNoSandboxArgs(): string[] {
  return ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'];
}

export function playwrightChromiumLaunchArgs(baseArgs: string[] = []): string[] {
  if (useChromiumOsSandbox()) return [...baseArgs];
  return [...chromiumNoSandboxArgs(), ...baseArgs];
}
