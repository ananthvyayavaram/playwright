/**
 * Persistent healing memory — stores successful locator fixes so the same
 * problem is never solved twice by the LLM.
 *
 * Storage format: flat JSON array at test-results/healing-memory.json
 * Key: normalizedPage + '||' + originalLocator
 */
import fs from 'fs';
import path from 'path';
import type { HealingMemoryEntry } from './types';

export class HealingMemory {
  private readonly memoryPath: string;
  private entries: HealingMemoryEntry[] = [];
  private loaded = false;

  constructor(memoryPath = 'test-results/healing-memory.json') {
    this.memoryPath = path.isAbsolute(memoryPath)
      ? memoryPath
      : path.resolve(process.cwd(), memoryPath);
  }

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    if (!fs.existsSync(this.memoryPath)) return;
    try {
      const raw = fs.readFileSync(this.memoryPath, 'utf-8');
      this.entries = JSON.parse(raw) as HealingMemoryEntry[];
    } catch {
      this.entries = [];
    }
  }

  private save(): void {
    try {
      fs.mkdirSync(path.dirname(this.memoryPath), { recursive: true });
      fs.writeFileSync(this.memoryPath, JSON.stringify(this.entries, null, 2), 'utf-8');
    } catch {
      // Non-fatal: memory persistence failure should not break healing
    }
  }

  private key(page: string, locator: string): string {
    return `${page}||${locator}`;
  }

  /** Find a cached healing result for the given page + locator */
  lookup(page: string, locator: string): HealingMemoryEntry | null {
    this.load();
    const k = this.key(page, locator);
    return this.entries.find(e => this.key(e.page, e.originalLocator) === k) ?? null;
  }

  /**
   * Record a successful healing.
   * If an entry already exists, increments its successCount and updates lastUsed.
   */
  record(
    page: string,
    originalLocator: string,
    healedExpression: string,
    action: string,
    confidence: number,
  ): void {
    this.load();
    const existing = this.lookup(page, originalLocator);
    const now = new Date().toISOString();

    if (existing) {
      existing.healedExpression = healedExpression;
      existing.confidence = confidence;
      existing.validated = true;
      existing.successCount += 1;
      existing.lastUsed = now;
    } else {
      this.entries.push({
        page,
        originalLocator,
        healedExpression,
        action,
        confidence,
        validated: true,
        timestamp: now,
        successCount: 1,
        lastUsed: now,
      });
    }

    this.save();
  }

  /**
   * Mark a previously-cached healing as invalid (element no longer exists or changed again).
   * The entry is removed so a fresh healing attempt starts from scratch.
   */
  invalidate(page: string, originalLocator: string): void {
    this.load();
    const k = this.key(page, originalLocator);
    this.entries = this.entries.filter(e => this.key(e.page, e.originalLocator) !== k);
    this.save();
  }

  /** Return all entries (for reporting/debugging) */
  all(): HealingMemoryEntry[] {
    this.load();
    return [...this.entries];
  }

  /** How many unique page+locator pairs have been healed */
  get size(): number {
    this.load();
    return this.entries.length;
  }
}
