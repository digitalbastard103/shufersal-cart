import { describe, expect, it } from 'vitest';

import { ShufersalClient } from '../src/shufersal/client.js';
import { FormBody, SessionError, type RawResponse, type Transport } from '../src/shufersal/transport.js';
import { parseCartLines, parseCartSummary } from '../src/shufersal/types.js';

// Markup trimmed from the captured mini-cart (2026-10).
function line(code: string, entry: number, qty: number, name: string, total: string, method = 'by_unit', methodOnArticle = true): string {
  return (
    `<article class="miglog-prod ${methodOnArticle ? `miglog-sellingmethod-${method} ` : ''}miglog-incart" data-medicine="false" ` +
    `data-product-code="${code}" data-entry-number="${entry}" data-entry-qty="${qty.toFixed(1)}" data-long-tail="false">` +
    `<h3 class="miglog-text3 miglog-prod-name "><a href="javascript:void(0)" data-product-code="${code}">${name}</a></h3>` +
    `<input data-miglog-sellingmethod = "${method.toUpperCase()}" name="qty"/>` +
    `<p class="miglog-text2 miglog-prod-totalPrize "> ${total}<span>₪</span></p></article>`
  );
}
const cart = (...lines: string[]) => `<div>${lines.join('')}</div>`;

describe('cart parsing', () => {
  it('reads lines with names (entities decoded), quantities, methods and line totals', () => {
    const html = cart(
      line('P_1', 3, 2, 'מיץ תפוזים', '23.80'),
      line('P_2', 0, 1, 'עוגיות חמאה &quot;קלאסי&quot;', '1,019.90', 'by_unit', false),
      line('P_3', 1, 350, 'גבינה צהובה', '17.50', 'by_package'),
    );
    expect(parseCartLines(html)).toEqual([
      { entryNumber: 3, code: 'P_1', name: 'מיץ תפוזים', quantity: 2, sellingMethod: 'BY_UNIT', lineTotal: 23.8 },
      { entryNumber: 0, code: 'P_2', name: 'עוגיות חמאה "קלאסי"', quantity: 1, sellingMethod: 'BY_UNIT', lineTotal: 1019.9 },
      { entryNumber: 1, code: 'P_3', name: 'גבינה צהובה', quantity: 350, sellingMethod: 'BY_PACKAGE', lineTotal: 17.5 },
    ]);
  });

  it("reads the summary page's own total and savings", () => {
    const html =
      '<span class="number miglog-regular" aria-hidden="true" id="cartTotalItems">28</span>' +
      '<div class="totalDiscount">סה”כ חסכת: <span>₪</span> שקלים חדשים 18.60 </div>' +
      '<div class="totalPrice miglog-cart-summary-visible-only miglog-cart-summary-totalprice"> 312.40 ₪ שקלים חדשים</div>';
    expect(parseCartSummary(html)).toEqual({ toPay: 312.40, savings: 18.6, itemCount: 28 });
  });
});

/** A fake site: serves a cart, applies cart/update the way the real one does (renumbering after removal). */
class FakeSite implements Transport {
  readonly posts: Array<{ path: string; body: unknown }> = [];
  constructor(public lines: Array<{ code: string; qty: number; name: string; method?: string }>, private readonly ignoreUpdates = false) {}

  private render(): string {
    return cart(...this.lines.map((l, i) => line(l.code, i, l.qty, l.name, '1.00', l.method ?? 'by_unit')));
  }

  async request(method: 'GET' | 'POST', path: string, body?: unknown): Promise<RawResponse> {
    if (method === 'POST') {
      this.posts.push({ path, body });
      const q = new URL(`https://x${path}`).searchParams;
      const entry = Number(q.get('entryNumber'));
      const qty = Number(q.get('qty'));
      if (!this.ignoreUpdates) {
        if (qty === 0) this.lines.splice(entry, 1);
        else this.lines[entry]!.qty = qty;
      }
    }
    return { status: 200, contentType: 'text/html', finalUrl: path, text: this.render() };
  }
  async pause(): Promise<void> {}
  async close(): Promise<void> {}
}

describe('setQuantity', () => {
  it('targets the current entry number, mirrors the captured request, and confirms the result', async () => {
    const site = new FakeSite([{ code: 'P_A', qty: 1, name: 'a' }, { code: 'P_B', qty: 1, name: 'b' }, { code: 'P_C', qty: 1, name: 'c' }]);
    const client = new ShufersalClient(site);

    await client.setQuantity('P_B', 0); // P_C shifts from entry 2 to entry 1
    const after = await client.setQuantity('P_C', 3);

    expect(after.map((l) => [l.code, l.entryNumber, l.quantity])).toEqual([
      ['P_A', 0, 1],
      ['P_C', 1, 3],
    ]);
    const [remove, change] = site.posts;
    expect(remove!.path).toBe(
      '/online/he/cart/update?entryNumber=1&qty=0&sellingMethod=&cartContext%5BopenFrom%5D=CART&cartContext%5BrecommendationType%5D=REGULAR&cartContext%5Baction%5D=remove',
    );
    expect(change!.path).toBe(
      '/online/he/cart/update?entryNumber=1&qty=3&sellingMethod=BY_UNIT&comment=&cartContext%5BopenFrom%5D=CART&cartContext%5BrecommendationType%5D=REGULAR',
    );
    expect(change!.body).toEqual(new FormBody({ quantity: '3' }));
  });

  it('refuses products not in the cart, bad quantities, and quantity changes on weighed items', async () => {
    const client = new ShufersalClient(new FakeSite([{ code: 'P_W', qty: 350, name: 'cheese', method: 'by_package' }]));
    await expect(client.setQuantity('P_X', 1)).rejects.toThrow(/not in the cart/);
    await expect(client.setQuantity('P_W', 2.5)).rejects.toThrow(SessionError);
    await expect(client.setQuantity('P_W', 2)).rejects.toThrow(/change its amount in the app/);
    await expect(client.setQuantity('P_W', 0)).resolves.toEqual([]);
  });

  it('reports a change the site did not apply instead of claiming success', async () => {
    const client = new ShufersalClient(new FakeSite([{ code: 'P_A', qty: 1, name: 'a' }], true));
    await expect(client.setQuantity('P_A', 4)).rejects.toThrow(/did not apply/);
  });
});
