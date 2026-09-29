// Shared CLI helpers used by record-to-spec.ts, flow.ts, analyze.ts, repair.ts
import readline from 'readline/promises';

export function parseArgs(argv: string[]): Record<string, string | boolean> {
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key  = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) { flags[key] = true; }
    else { flags[key] = next; i++; }
  }
  return flags;
}

export function slugify(str: string): string {
  return str.toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
}

export async function promptForUrl(defaultUrl: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const hint = defaultUrl
      ? `\n  Enter URL to record (press Enter for default):\n  Default : ${defaultUrl}\n  URL     : `
      : '\n  Enter URL to record:\n  URL     : ';
    const answer = await rl.question(hint);
    const trimmed = answer.trim();
    if (!trimmed && !defaultUrl) {
      console.error('\n  ✗ No URL provided. Please enter a URL or set BASE_URL in .env');
      process.exit(1);
    }
    return trimmed || defaultUrl;
  } finally {
    rl.close();
  }
}
