import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { fillCart } from '../src/cart/fill.js';
import { Choices, choiceKey } from '../src/list/choices.js';
import { normalize } from '../src/list/match.js';
import { parseList } from '../src/list/parse-list.js';
import type { ShufersalClient } from '../src/shufersal/client.js';
import type { Candidate } from '../src/shufersal/types.js';

const product = (sku: string, name: string, extra: Partial<Candidate> = {}): Candidate => ({
  code: `P_${sku}`,
  sku,
  name,
  brand: null,
  unitDescription: null,
  sellingMethod: 'BY_UNIT',
  inStock: true,
  price: 7.35,
  priceText: '7.35 ₪',
  ...extra,
});

/** Just enough of ShufersalClient for fillCart. Records which lookups happened. */
function fakeClient(catalog: Candidate[]) {
  const calls: string[] = [];
  const client = {
    cart: async () => new Map<string, number>(),
    search: async (q: string) => {
      calls.push(`search:${q}`);
      return catalog.filter((c) => c.name.includes(q.split(' ')[0]!));
    },
    findBySku: async (sku: string) => {
      calls.push(`sku:${sku}`);
      return catalog.find((c) => c.sku === sku) ?? null;
    },
    addBulk: async (items: Array<{ code: string; qty: number }>) => new Map(items.map((i) => [i.code, i.qty])),
  } as unknown as ShufersalClient;
  return { client, calls };
}

const run = (client: ShufersalClient, text: string, choices = Choices.empty(), dryRun = false) =>
  fillCart(client, parseList(text).items, { dryRun, choices, delayMs: 0, pause: async () => {} });

describe('choice keys', () => {
  it('match regardless of word order, punctuation, and "3 אחוז" vs "3%"', () => {
    expect(choiceKey('חלב 3 אחוז')).toBe(choiceKey('חלב 3%'));
    expect(choiceKey('3% חלב')).toBe(choiceKey('חלב 3%'));
    expect(choiceKey('קוטג׳ 5%')).toBe(choiceKey('קוטג 5 אחוז'));
    expect(choiceKey('חלב 3%')).not.toBe(choiceKey('חלב 1%'));
    expect(normalize('חלב 3.5 אחוז')).toBe('חלב 3.5%');
  });

  it('persist to a file and survive reloading', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'choices-')), 'choices.json');
    Choices.load(file).set('חלב 3%', { code: 'P_4131074', sku: '4131074', name: 'חלב בקרטון 3% שומן' });
    const again = Choices.load(file);
    expect(again.get('חלב 3 אחוז')).toMatchObject({ code: 'P_4131074', query: 'חלב 3%' });
    expect(again.remove('3% חלב')).toBe(true);
    expect(Choices.load(file).all()).toEqual([]);
  });
});

describe('list lines with a מקט', () => {
  it('parse a bare number as a מקט, with or without a quantity', () => {
    expect(parseList('4131074 x2\n7290110115234\nביצים L 12').items).toMatchObject([
      { sku: '4131074', quantity: 2, query: '' },
      { sku: '7290110115234', quantity: 1 },
      { query: 'ביצים L 12' },
    ]);
  });
});

describe('fill with exact lookups', () => {
  const catalog = [
    product('4131074', 'חלב בקרטון 3% שומן', { brand: 'תנובה' }),
    product('7290116936307', 'חלב 3% שומן מהדרין', { brand: 'תנובה', price: 14.7 }),
  ];

  it('without a remembered choice, an ambiguous line is not guessed', async () => {
    const { client } = fakeClient(catalog);
    const result = await run(client, 'חלב 3%');
    expect(result.outcomes[0]!.status).toBe('ambiguous');
  });

  it('with a remembered choice, the line resolves by exact מקט - no search', async () => {
    const { client, calls } = fakeClient(catalog);
    const choices = Choices.empty();
    choices.set('חלב 3%', { code: 'P_4131074', sku: '4131074', name: 'חלב בקרטון 3% שומן' });

    const result = await run(client, 'חלב 3 אחוז x2', choices);
    expect(calls).toEqual(['sku:4131074']);
    expect(result.outcomes[0]).toMatchObject({ status: 'added', via: 'remembered', cartQty: 2, product: { code: 'P_4131074' } });
  });

  it('a remembered product that is out of stock is reported, not added or swapped', async () => {
    const { client } = fakeClient([product('4131074', 'חלב בקרטון 3% שומן', { inStock: false })]);
    const choices = Choices.empty();
    choices.set('חלב 3%', { code: 'P_4131074', sku: '4131074', name: 'חלב' });
    expect((await run(client, 'חלב 3%', choices)).outcomes[0]!.status).toBe('out-of-stock');
  });

  it('a מקט line that matches nothing is an error, never a fuzzy match', async () => {
    const { client, calls } = fakeClient(catalog);
    const result = await run(client, '9999999');
    expect(calls).toEqual(['sku:9999999']);
    expect(result.outcomes[0]).toMatchObject({ status: 'error' });
  });
});
