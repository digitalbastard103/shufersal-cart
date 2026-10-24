import { describe, expect, it } from 'vitest';

import { parseList } from '../src/list/parse-list.js';
import { parseOrderItems, parseOrders, parseSavedListItems, parseSavedLists, toListFile } from '../src/shufersal/types.js';

// Shapes copied (trimmed) from the 2026-10 capture / live check.
const ordersBody = {
  activeOrders: [],
  closedOrders: [
    { code: '00000001', createdString: '2026/02/14 09:40', totalPrice: { value: 187.55 }, totalItems: 35 },
    { code: '00000002', createdString: '2026/03/02 10:15', totalPrice: { value: 214.30 }, totalItems: 28 },
    { code: null, createdString: '2026/01/01 10:00' },
  ],
};

const orderDetail = {
  entries: [
    { quantity: 2, product: { code: 'P_4130800', name: 'חלב 3%', sellingMethod: { code: 'BY_UNIT' }, stock: { stockLevelStatus: { code: 'inStock' } } } },
    { quantity: 350, frontQuantity: 1, product: { code: 'P_1', name: 'גבינה צהובה 9%', sellingMethod: { code: 'BY_PACKAGE' } } },
    { quantity: 1, outOfStock: true, product: { code: 'P_2', name: 'במבה', sellingMethod: { code: 'BY_UNIT' } } },
    { quantity: 1, product: {} },
    { quantity: 1, product: { code: 'P_1159', name: 'משלוח שופרסל אונליין', deliveryItem: true, sellingMethod: { code: 'BY_UNIT' } } },
  ],
};

const savedList = {
  name: 'לחג',
  entries: [
    { quantity: 3, unitOfMeasure: 'BY_UNIT', product: { productCode: 'P_10', quantity: 3, isOutOfStock: false, product: { name: 'יין' } } },
    { quantity: 1, unitOfMeasure: 'BY_WEIGHT', product: { productCode: 'P_11', product: { name: 'עגבניות' } } },
  ],
};

describe('history parsing', () => {
  it('lists orders newest first and skips malformed ones', () => {
    expect(parseOrders(ordersBody)).toEqual([
      { code: '00000002', created: '2026-03-02 10:15', total: 214.30, itemCount: 28 },
      { code: '00000001', created: '2026-02-14 09:40', total: 187.55, itemCount: 35 },
    ]);
  });

  it('reads order items with selling method and stock, leaving out the delivery fee', () => {
    expect(parseOrderItems(orderDetail)).toEqual([
      { code: 'P_4130800', name: 'חלב 3%', quantity: 2, sellingMethod: 'BY_UNIT', outOfStock: false },
      { code: 'P_1', name: 'גבינה צהובה 9%', quantity: 350, sellingMethod: 'BY_PACKAGE', outOfStock: false },
      { code: 'P_2', name: 'במבה', quantity: 1, sellingMethod: 'BY_UNIT', outOfStock: true },
    ]);
  });

  it('reads saved lists and their items', () => {
    expect(parseSavedLists([{ shoppingListId: '10000001', name: 'לחג', entriesNumber: 8 }, { name: 'no id' }])).toEqual([
      { id: '10000001', name: 'לחג', itemCount: 8 },
    ]);
    expect(parseSavedListItems(savedList)).toEqual([
      { code: 'P_10', name: 'יין', quantity: 3, sellingMethod: 'BY_UNIT', outOfStock: false },
      { code: 'P_11', name: 'עגבניות', quantity: 1, sellingMethod: 'BY_WEIGHT', outOfStock: false },
    ]);
  });

  it('writes a list file that cart:fill reads back as only the addable items', () => {
    const text = toListFile('From order 00000002', parseOrderItems(orderDetail));
    // The 350 g package must never become "x350".
    expect(text).not.toContain('x350');
    expect(text).toContain('# P_1 ');
    const { items, errors } = parseList(text);
    expect(errors).toEqual([]);
    expect(items).toEqual([{ line: 4, raw: 'P_4130800 x2', query: '', productCode: 'P_4130800', quantity: 2, note: 'חלב 3%' }]);
  });

  it('never writes a quantity the list parser would reject', () => {
    const text = toListFile('t', [{ code: 'P_9', name: 'x', quantity: 0.5, sellingMethod: 'BY_UNIT', outOfStock: false }]);
    expect(parseList(text).items[0]).toMatchObject({ productCode: 'P_9', quantity: 1 });
  });
});
