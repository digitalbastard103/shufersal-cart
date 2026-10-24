import { describe, expect, it } from 'vitest';

import { decide, normalize, score } from '../src/list/match.js';
import { parseCartEntries, toCandidate, type Candidate } from '../src/shufersal/types.js';

function c(code: string, name: string, extra: Partial<Candidate> = {}): Candidate {
  return { code, name, brand: null, unitDescription: null, sellingMethod: 'BY_UNIT', inStock: true, price: 5, priceText: '5.00 ₪', ...extra };
}

describe('normalize / score', () => {
  it('ignores quotes, geresh and punctuation', () => {
    expect(normalize('קוטג׳ "תנובה" 5%')).toBe('קוטג תנובה 5%');
  });

  it('matches tokens as prefixes against name, brand and unit', () => {
    expect(score('חלב תנובה', c('P_1', 'חלב 3% בקרטון', { brand: 'תנובה' }))).toBe(1);
    expect(score('חלב סויה', c('P_1', 'חלב 3% בקרטון'))).toBe(0.5);
  });
});

describe('decide', () => {
  it('picks the only product that matches every word', () => {
    const d = decide('במבה נוגט', [c('P_1', 'במבה'), c('P_2', 'במבה במילוי נוגט'), c('P_3', 'ביסלי')]);
    expect(d).toEqual({ kind: 'confident', pick: expect.objectContaining({ code: 'P_2' }) });
  });

  it('refuses to choose between several full matches', () => {
    const d = decide('חלב 3%', [c('P_1', 'חלב 3% 1 ליטר'), c('P_2', 'חלב 3% 2 ליטר'), c('P_3', 'שוקו')]);
    expect(d.kind).toBe('ambiguous');
    // P_3 shares no word with the line, so it is not offered as a candidate.
    if (d.kind === 'ambiguous') expect(d.candidates.map((x) => x.code)).toEqual(['P_1', 'P_2']);
  });

  it('accepts an exact name match among several full matches', () => {
    const d = decide('לחם אחיד', [c('P_1', 'לחם אחיד פרוס'), c('P_2', 'לחם אחיד')]);
    expect(d).toEqual({ kind: 'confident', pick: expect.objectContaining({ code: 'P_2' }) });
  });

  it('never picks an out-of-stock product', () => {
    const d = decide('במבה', [c('P_1', 'במבה', { inStock: false })]);
    expect(d.kind).toBe('out-of-stock');
  });

  it('skips the out-of-stock match when an in-stock one exists', () => {
    const d = decide('במבה נוגט', [c('P_1', 'במבה נוגט', { inStock: false }), c('P_2', 'במבה במילוי נוגט')]);
    expect(d).toEqual({ kind: 'confident', pick: expect.objectContaining({ code: 'P_2' }) });
  });

  it('reports nothing found when no word matches', () => {
    expect(decide('אבוקדו', [c('P_1', 'מגבות נייר')])).toEqual({ kind: 'none' });
  });
});

describe('site response parsing', () => {
  it('maps a raw search result, treating only explicit outOfStock as unavailable', () => {
    expect(
      toCandidate({
        code: 'P_7296073739852',
        name: ' מגבות נייר ',
        brandName: 'LENOVO',
        sellingMethod: { code: 'BY_UNIT' },
        stock: { stockLevelStatus: { code: 'inStock' } },
        price: { value: 1999, formattedValue: '1,999.00 ₪' },
      }),
    ).toMatchObject({ code: 'P_7296073739852', name: 'מגבות נייר', inStock: true, price: 1999, sellingMethod: 'BY_UNIT' });
    expect(toCandidate({ code: 'P_1', name: 'x', stock: { stockLevelStatus: { code: 'outOfStock' } } })!.inStock).toBe(false);
    expect(toCandidate({ name: 'no code' })).toBeNull();
  });

  it('reads cart entries from the mini-cart HTML shape seen in the capture', () => {
    const html =
      '<div class="miglog-prod" data-medicine="false" data-product-code="P_7296073757184" data-entry-number="0" data-entry-qty="1.0">' +
      '<button data-product="P_7296073757184"></button>' +
      '<div class="x" data-product-code="P_1594155" data-entry-number="1" data-entry-qty="3.0"></div>' +
      '<span data-product-code="P_999"></span>';
    expect([...parseCartEntries(html)]).toEqual([
      ['P_7296073757184', 1],
      ['P_1594155', 3],
    ]);
  });
});
