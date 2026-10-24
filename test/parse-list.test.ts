import { describe, expect, it } from 'vitest';

import { parseList } from '../src/list/parse-list.js';

describe('parseList', () => {
  it('skips blank lines and comments', () => {
    expect(parseList('\n# comment\n   \nחלב\n').items.map((i) => i.query)).toEqual(['חלב']);
  });

  it('reads a trailing or leading multiplier', () => {
    const { items } = parseList('חלב 3% x2\n3 x במבה\nלחם ×4\nגבינה * 2');
    expect(items.map((i) => [i.query, i.quantity])).toEqual([
      ['חלב 3%', 2],
      ['במבה', 3],
      ['לחם', 4],
      ['גבינה', 2],
    ]);
  });

  it('keeps bare numbers as part of the product text', () => {
    const { items } = parseList('ביצים L 12\nקוקה קולה 1.5\nחלב 3%');
    expect(items.map((i) => [i.query, i.quantity])).toEqual([
      ['ביצים L 12', 1],
      ['קוקה קולה 1.5', 1],
      ['חלב 3%', 1],
    ]);
  });

  it('recognises a pinned product code', () => {
    const { items } = parseList('P_7290000042011 x3\np_123');
    expect(items).toMatchObject([
      { productCode: 'P_7290000042011', quantity: 3, query: '' },
      { productCode: 'P_123', quantity: 1 },
    ]);
  });

  it('ignores a note after the item', () => {
    const { items } = parseList('P_4131074 x2          # חלב תנובה 3%\nלחם אחיד # שופרסל');
    expect(items).toMatchObject([
      { productCode: 'P_4131074', quantity: 2, note: 'חלב תנובה 3%' },
      { query: 'לחם אחיד', quantity: 1, note: 'שופרסל' },
    ]);
  });

  it('rejects absurd quantities and empty product text instead of guessing', () => {
    const { items, errors } = parseList('חלב x0\nחלב x99\nx2');
    expect(items).toEqual([]);
    expect(errors.map((e) => e.line)).toEqual([1, 2, 3]);
  });

  it("strips ':' which the site uses as a sort separator", () => {
    expect(parseList('קפה: נמס').items[0]!.query).toBe('קפה נמס');
  });
});
