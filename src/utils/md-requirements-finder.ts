// Finds the original MD requirements flow that produced a given generated spec file.
// Used by the healer to provide ground-truth intent when repairing failures.
import { readdirSync, readFileSync, existsSync } from 'fs';
import path from 'path';

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

export interface MdRequirementsMatch {
  mdPath:          string;
  flowTitle:       string;
  flowDescription: string;
  fullMdContent:   string;
  /** baseUrl from the MD frontmatter — used by the healer to navigate to the correct page */
  baseUrl?:        string;
}

/**
 * Given a spec file path (e.g. tests/generated/create-collection-flow.spec.ts),
 * scans all .md files in requirementsDir and returns the first flow whose title
 * slug matches the spec filename slug.
 *
 * Falls back to returning the entire MD file content if an exact flow match
 * is not found but the MD file is clearly related (same slug prefix).
 */
export function findMdForSpec(
  specPath:        string,
  requirementsDir: string,
): MdRequirementsMatch | null {
  if (!existsSync(requirementsDir)) return null;

  const specBasename = path.basename(specPath, '.spec.ts'); // e.g. "create-collection-flow"

  let mdFiles: string[];
  try {
    mdFiles = readdirSync(requirementsDir)
      .filter(f => f.endsWith('.md'))
      .map(f => path.join(requirementsDir, f));
  } catch {
    return null;
  }

  // Collect all parsed sections for multi-pass matching
  const allSections: Array<{
    mdPath: string;
    raw: string;
    mdBasename: string;
    title: string;
    titleSlug: string;
    description: string;
    baseUrl?: string;
  }> = [];

  for (const mdPath of mdFiles) {
    let raw: string;
    try { raw = readFileSync(mdPath, 'utf-8'); }
    catch { continue; }

    const mdBasename = slugify(path.basename(mdPath, '.md'));
    // Parse baseUrl from frontmatter (between leading --- markers)
    const fmMatch = raw.match(/^---\n([\s\S]*?)\n---/);
    const baseUrl = fmMatch ? (fmMatch[1].match(/baseUrl:\s*(.+)/)?.[1]?.trim() ?? undefined) : undefined;

    for (const section of raw.split(/\n(?=## )/)) {
      const titleMatch = section.match(/^## (.+)/);
      if (!titleMatch) continue;

      const title       = titleMatch[1].trim();
      const titleSlug   = slugify(title);
      const description = section.slice(section.indexOf('\n') + 1)
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/^---+\s*$/gm, '')
        .trim();

      allSections.push({ mdPath, raw, mdBasename, title, titleSlug, description, baseUrl });
    }
  }

  // Pass 1: spec file was named after the MD file (e.g. collections.spec.ts → collections.md)
  // Since toSpecFileName uses the MD basename, check that first — most reliable match.
  for (const s of allSections) {
    if (
      specBasename === s.mdBasename ||
      specBasename.startsWith(s.mdBasename + '-') ||
      s.mdBasename.startsWith(specBasename + '-')
    ) {
      return { mdPath: s.mdPath, flowTitle: s.title, flowDescription: s.description, fullMdContent: s.raw, baseUrl: s.baseUrl };
    }
  }

  // Pass 2: spec file matches the flow title slug exactly
  for (const s of allSections) {
    if (
      specBasename === s.titleSlug ||
      specBasename.startsWith(s.titleSlug) ||
      s.titleSlug.startsWith(specBasename)
    ) {
      return { mdPath: s.mdPath, flowTitle: s.title, flowDescription: s.description, fullMdContent: s.raw, baseUrl: s.baseUrl };
    }
  }

  // Pass 3: significant word overlap between spec basename and title slug
  for (const s of allSections) {
    const specWords  = new Set(specBasename.split('-').filter(w => w.length > 3));
    const titleWords = new Set(s.titleSlug.split('-').filter(w => w.length > 3));
    const overlap    = [...specWords].filter(w => titleWords.has(w)).length;
    if (overlap >= 2 && overlap >= Math.min(specWords.size, titleWords.size) * 0.6) {
      return { mdPath: s.mdPath, flowTitle: s.title, flowDescription: s.description, fullMdContent: s.raw, baseUrl: s.baseUrl };
    }
  }

  return null;
}

/**
 * Builds a compact requirements string to pass to the healer.
 * Includes frontmatter config (credentials, URL) plus the flow description.
 */
export function buildRequirementsContext(match: MdRequirementsMatch): string {
  // Extract frontmatter for credentials/URL
  const fmMatch = match.fullMdContent.match(/^---\s*\n([\s\S]*?)\n---/);
  const fm      = fmMatch ? fmMatch[1] : '';

  return `## Flow: ${match.flowTitle}
Source: ${match.mdPath}

### Configuration
${fm}

### What this test should do
${match.flowDescription}`;
}
