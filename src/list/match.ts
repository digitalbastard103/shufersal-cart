import type { Candidate } from '../shufersal/types.js';

/**
 * Deciding which search result a list line means.
 *
 * Deliberately conservative: a wrong product in the cart costs real money and
 * is easy to miss at checkout, while an "ambiguous" line costs one look at the
 * printed candidates. So a line is only auto-picked when the choice is
 * unambiguous; anything else is reported, never guessed. Pinning a `P_` code
 * in the list is the way to make a recurring item automatic.
 */

export type MatchDecision =
  | { kind: 'confident'; pick: Candidate }
  | { kind: 'ambiguous'; candidates: Candidate[] }
  | { kind: 'out-of-stock'; candidates: Candidate[] }
  | { kind: 'none' };

export const MAX_CANDIDATES_SHOWN = 4;

export function normalize(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/[֑-ׇ]/g, '') // niqqud / cantillation
    .replace(/["'`׳״]/g, '')
    // "3 אחוז" and "3%" are the same thing; product names use "%".
    .replace(/(\d+(?:\.\d+)?)\s*אחוז/g, '$1%')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}%.]+/gu, ' ')
    .trim();
}

export function tokens(text: string): string[] {
  return normalize(text).split(' ').filter(Boolean);
}

/** Fraction of query tokens found in the candidate's name / brand / unit text. */
export function score(query: string, candidate: Candidate): number {
  const wanted = tokens(query);
  if (wanted.length === 0) return 0;
  const have = tokens([candidate.name, candidate.brand ?? '', candidate.unitDescription ?? ''].join(' '));
  const hits = wanted.filter((w) => have.some((h) => h === w || h.startsWith(w))).length;
  return hits / wanted.length;
}

export function decide(query: string, results: Candidate[]): MatchDecision {
  const scored = results
    .map((candidate, rank) => ({ candidate, rank, score: score(query, candidate) }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.rank - b.rank);

  if (scored.length === 0) return { kind: 'none' };

  const inStock = scored.filter((s) => s.candidate.inStock);
  if (inStock.length === 0) {
    return { kind: 'out-of-stock', candidates: scored.slice(0, MAX_CANDIDATES_SHOWN).map((s) => s.candidate) };
  }

  const full = inStock.filter((s) => s.score === 1);
  const exactName = full.filter((s) => normalize(s.candidate.name) === normalize(query));

  // Exactly one product fully matches, or exactly one is named exactly what
  // the line says. Anything else - several sizes, several brands - is a choice.
  if (full.length === 1) return { kind: 'confident', pick: full[0]!.candidate };
  if (exactName.length === 1) return { kind: 'confident', pick: exactName[0]!.candidate };

  return { kind: 'ambiguous', candidates: inStock.slice(0, MAX_CANDIDATES_SHOWN).map((s) => s.candidate) };
}
