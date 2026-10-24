import fs from 'node:fs';
import path from 'node:path';

import { tokens } from './match.js';

/**
 * Remembered choices: "when the list says X, I mean this product".
 *
 * When a line is ambiguous ("חלב 3%" matches several products) and the user
 * picks one, the choice is stored here by מקט. Next time the same line is
 * looked up by that מקט - an exact lookup with live price and stock - instead
 * of being searched and guessed. Lines are compared by their words, in any
 * order, with "3 אחוז" == "3%" (see `normalize` in match.ts).
 *
 * The file is personal shopping data: kept under lists/ (gitignored).
 */

export type Choice = {
  /** Product code at the time of choosing, e.g. "P_4131074". */
  code: string;
  /** מקט used for the exact lookup. */
  sku: string;
  name: string;
  /** The line as the user wrote it when choosing. */
  query: string;
  savedAt: string;
};

type ChoicesFile = { version: 1; choices: Record<string, Choice> };

export function choiceKey(query: string): string {
  return [...new Set(tokens(query))].sort().join(' ');
}

export class Choices {
  private readonly entries: Map<string, Choice>;

  private constructor(
    private readonly file: string | null,
    entries: Record<string, Choice>,
  ) {
    this.entries = new Map(Object.entries(entries));
  }

  /** A missing or unreadable file means "no choices yet" - never an error. */
  static load(file: string): Choices {
    const full = path.resolve(process.cwd(), file);
    try {
      const parsed = JSON.parse(fs.readFileSync(full, 'utf8')) as Partial<ChoicesFile>;
      return new Choices(full, parsed.choices && typeof parsed.choices === 'object' ? parsed.choices : {});
    } catch {
      return new Choices(full, {});
    }
  }

  /** In-memory only (tests). */
  static empty(): Choices {
    return new Choices(null, {});
  }

  get(query: string): Choice | undefined {
    const key = choiceKey(query);
    return key ? this.entries.get(key) : undefined;
  }

  set(query: string, choice: Omit<Choice, 'query' | 'savedAt'>): Choice {
    const key = choiceKey(query);
    if (!key) throw new Error('Cannot remember a choice for an empty line.');
    const entry: Choice = { ...choice, query: query.trim(), savedAt: new Date().toISOString() };
    this.entries.set(key, entry);
    this.save();
    return entry;
  }

  remove(query: string): boolean {
    const removed = this.entries.delete(choiceKey(query));
    if (removed) this.save();
    return removed;
  }

  all(): Choice[] {
    return [...this.entries.values()].sort((a, b) => a.query.localeCompare(b.query, 'he'));
  }

  private save(): void {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const data: ChoicesFile = { version: 1, choices: Object.fromEntries(this.entries) };
    fs.writeFileSync(this.file, JSON.stringify(data, null, 2) + '\n', 'utf8');
  }
}
