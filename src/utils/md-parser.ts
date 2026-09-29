// Parses requirements .md files (YAML frontmatter + ## sections) into flow configs for the AI test generator.
/**
 * Parses requirement markdown files into flow configurations.
 *
 * File format:
 *   ---
 *   baseUrl:   https://example.com   (required)
 *   model:     claude-sonnet-5       (optional)
 *   outputDir: tests/generated       (optional)
 *   mode:      test | pom            (optional, default: pom)
 *   headed:    false                 (optional)
 *   maxTurns:  30                    (optional)
 *   ---
 *
 *   ## Flow Title
 *   Description text (multi-line OK).
 *   <!-- url: https://other-page.com -->   (optional per-flow URL override)
 *   <!-- mode: pom -->                     (optional per-flow mode override)
 */
import { GenerationMode } from '../ai/flow-generator';

export interface MdConfig {
  baseUrl:      string;
  model:        string;
  outputDir:    string;
  mode:         GenerationMode;
  headed:       boolean;
  maxTurns:     number;
  username?:    string;
  password?:    string;
  storageState?: string;
}

export interface ParsedFlow {
  title:       string;
  description: string;
  url:         string;
  mode:        GenerationMode;
}

export function parseFrontmatter(raw: string): { config: Partial<MdConfig>; body: string } {
  const fmMatch = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
  if (!fmMatch) return { config: {}, body: raw };

  const config: Partial<MdConfig> = {};
  for (const line of fmMatch[1].split('\n')) {
    const [rawKey, ...rest] = line.split(':');
    if (!rawKey) continue;
    const key   = rawKey.trim();
    const value = rest.join(':').trim();
    if (!value) continue;
    switch (key) {
      case 'baseUrl':      config.baseUrl      = value; break;
      case 'model':        config.model        = value; break;
      case 'outputDir':    config.outputDir    = value; break;
      case 'mode':         config.mode         = value as GenerationMode; break;
      case 'headed':       config.headed       = value === 'true'; break;
      case 'maxTurns':     config.maxTurns     = parseInt(value, 10); break;
      case 'username':     config.username     = value; break;
      case 'password':     config.password     = value; break;
      case 'storageState': config.storageState = value; break;
    }
  }
  return { config, body: fmMatch[2] };
}

export function parseFlows(body: string, defaults: MdConfig): ParsedFlow[] {
  const flows: ParsedFlow[] = [];

  for (const section of body.split(/\n(?=## )/)) {
    const titleMatch = section.match(/^## (.+)/);
    if (!titleMatch) continue;

    const title = titleMatch[1].trim();
    let description = section.slice(section.indexOf('\n') + 1).trim();

    const urlOverride  = description.match(/<!--\s*url:\s*(.+?)\s*-->/)?.[1];
    const modeOverride = description.match(/<!--\s*mode:\s*(test|pom)\s*-->/)?.[1] as GenerationMode | undefined;

    description = description
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/^---+\s*$/gm, '')
      .trim();

    if (!description) {
      console.warn(`[md-parser] Flow "${title}" has no description — skipping.`);
      continue;
    }

    flows.push({ title, description, url: urlOverride || defaults.baseUrl, mode: modeOverride || defaults.mode });
  }

  return flows;
}

export function buildConfig(partial: Partial<MdConfig>): MdConfig {
  if (!partial.baseUrl) throw new Error('Requirements file must have a "baseUrl" in its frontmatter.');
  return {
    baseUrl:      partial.baseUrl,
    model:        partial.model        ?? 'claude-sonnet-5',
    outputDir:    partial.outputDir    ?? 'tests/generated',
    mode:         partial.mode         ?? 'pom',
    headed:       partial.headed       ?? false,
    maxTurns:     partial.maxTurns     ?? 40,
    username:     partial.username,
    password:     partial.password,
    storageState: partial.storageState,
  };
}
