import { describe, expect, it } from 'vitest';

import { counts, fillCart, summarize } from '../src/cart/fill.js';
import { parseList } from '../src/list/parse-list.js';
import { ShufersalClient } from '../src/shufersal/client.js';
import type { Candidate } from '../src/shufersal/types.js';

const product = (code: string, name: string, extra: Partial<Candidate> = {}): Candidate => ({
  code,
  sku: code.replace(/^P_/, '').split('_')[0]!,
  name,
  brand: null,
  unitDescription: null,
  sellingMethod: 'BY_UNIT',
  inStock: true,
  price: 7.35,
  priceText: '7.35 ₪',
  ...extra,
});

/** Just enough of ShufersalClient for fillCart, with an existing cart. Records lookups and bulk adds. */
function fakeClient(catalog: Candidate[], inCart: Record<string, number> = {}) {
  const lookups: string[] = [];
  const bulk: Array<Array<{ code: string; qty: number }>> = [];
  const client = {
    cart: async () => new Map(Object.entries(inCart)),
    search: async () => [],
    findBySku: async () => null,
    findByCode: async (code: string) => {
      lookups.push(code);
      return catalog.find((c) => c.code === code) ?? null;
    },
    addBulk: async (items: Array<{ code: string; qty: number }>) => {
      bulk.push(items);
      return new Map(items.map((i) => [i.code, i.qty]));
    },
  } as unknown as ShufersalClient;
  return { client, lookups, bulk };
}

const run = (client: ShufersalClient, text: string, dryRun = false) =>
  fillCart(client, parseList(text).items, { dryRun, delayMs: 0, pause: async () => {} });

const catalog = [
  product('P_7290110563462', 'חלב נטול לקטוז 2%'),
  product('P_939995', 'פילה סלמון קפוא', { sellingMethod: 'BY_WEIGHT' }),
  product('P_1111111', 'אזל מהמלאי', { inStock: false }),
  product('P_7296073409441_42', 'וריאנט'),
];

describe('pinned product codes are checked like any other line', () => {
  it('an unknown code is not found in a dry run, and nothing is sent', async () => {
    const { client, bulk } = fakeClient(catalog);
    const result = await run(client, 'P_9999999999999 x1', true);
    expect(result.outcomes[0]).toMatchObject({ status: 'not-found' });
    expect(bulk).toEqual([]);
  });

  it('weighed and out-of-stock products are reported, not queued', async () => {
    const { client } = fakeClient(catalog);
    const result = await run(client, 'P_939995 x1\nP_1111111', true);
    expect(result.outcomes.map((o) => o.status)).toEqual(['by-weight', 'out-of-stock']);
  });

  it('a product already in the cart needs no lookup', async () => {
    const { client, lookups } = fakeClient(catalog, { P_7290110563462: 1 });
    const result = await run(client, 'P_7290110563462 x2');
    expect(result.outcomes[0]).toMatchObject({ status: 'already-in-cart', cartQty: 1 });
    expect(lookups).toEqual([]);
  });

  it('variant codes are looked up and added', async () => {
    const { client, bulk } = fakeClient(catalog);
    const result = await run(client, 'P_7296073409441_42 x2');
    expect(result.outcomes[0]).toMatchObject({ status: 'added', cartQty: 2 });
    expect(bulk).toEqual([[{ code: 'P_7296073409441_42', qty: 2 }]]);
  });
});

describe('duplicate lines', () => {
  it('add up into one quantity', async () => {
    const { client, bulk } = fakeClient(catalog);
    const result = await run(client, 'P_7290110563462 x2\nP_7290110563462 x3');
    expect(result.outcomes.map((o) => o.status)).toEqual(['added', 'merged']);
    expect(result.outcomes[1]).toMatchObject({ line: 1, total: 5 });
    expect(bulk).toEqual([[{ code: 'P_7290110563462', qty: 5 }]]);
  });

  it('keep each line\'s own quantity and carry the total on the first', async () => {
    const { client } = fakeClient(catalog);
    const result = await run(client, '2 x P_7290110563462\nP_7290110563462 ×2', true);
    expect(result.outcomes[0]).toMatchObject({ status: 'would-add', item: { quantity: 2 }, total: 4 });
    expect(result.outcomes[1]).toMatchObject({ status: 'merged', item: { quantity: 2 }, total: 4 });
  });

  it('over the limit refuse the whole group, so none of it is added', async () => {
    const { client, bulk } = fakeClient(catalog);
    const result = await run(client, 'P_7290110563462 x20\nP_7296073409441_42\nP_7290110563462 x20\nP_7290110563462 x1');
    const message = 'lines with this product add up to 40 units, more than 30; none of them was added';
    expect(result.outcomes.map((o) => o.status)).toEqual(['error', 'added', 'error', 'error']);
    expect(result.outcomes[0]).toMatchObject({ message });
    expect(bulk).toEqual([[{ code: 'P_7296073409441_42', qty: 1 }]]);
    expect(counts(result, 4)).toMatchObject({ added: 1, needsAttention: 3, complete: false });
  });
});

describe('counts and summary cover every requested line', () => {
  it('include skipped and invalid lines and say when the result is incomplete', async () => {
    const { client } = fakeClient(catalog);
    const result = await run(client, 'P_7290110563462 x2\nP_7290110563462 x1\nP_9999999999999', true);
    expect(counts(result, 3, { skipped: 7, invalid: 2 })).toEqual({
      requestedLines: 12, wouldAdd: 1, alreadyInCart: 0, merged: 1, needsAttention: 10, skipped: 7, invalid: 2, complete: false,
    });
    expect(summarize(result, 3, { skipped: 7, invalid: 2 })).toBe('Would add 1 of 12. Already in cart: 0. Merged duplicates: 1. Needs you: 10.');
    expect(counts(result, 3).complete).toBe(false);
  });

  it('report a list whose every line is malformed as incomplete, not empty', () => {
    expect(counts({ dryRun: true, outcomes: [], stoppedEarly: null }, 0, { invalid: 1 })).toMatchObject({ requestedLines: 1, wouldAdd: 0, needsAttention: 1, invalid: 1, complete: false });
  });

  it('are complete only when every line went through', async () => {
    const { client } = fakeClient(catalog);
    const result = await run(client, 'P_7290110563462 x2');
    expect(counts(result, 1)).toMatchObject({ requestedLines: 1, added: 1, needsAttention: 0, complete: true });
  });
});

describe('findByCode', () => {
  it('returns only the exact code among the variants of a מקט', async () => {
    const variants = [product('P_7296073409441', 'בסיס'), product('P_7296073409441_42', 'וריאנט')];
    const self = { search: async (q: string) => (q === '7296073409441' ? variants : []) };
    expect((await ShufersalClient.prototype.findByCode.call(self, 'p_7296073409441_42'))?.name).toBe('וריאנט');
    expect(await ShufersalClient.prototype.findByCode.call(self, 'P_7296073409441_99')).toBeNull();
  });
});
