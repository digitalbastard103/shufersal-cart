/**
 * Shapes taken from a real browser capture (HAR) of shufersal.co.il, 2026-10.
 * These are the site's own internal endpoints (SAP Commerce / Hybris), not a
 * published API - they can change without notice. Only the fields this tool
 * reads are typed; everything is optional because none of it is guaranteed.
 */

export const SHUFERSAL_ORIGIN = 'https://www.shufersal.co.il';
export const SHUFERSAL_HOME = `${SHUFERSAL_ORIGIN}/online/he/A`;

export const ENDPOINTS = {
  /** `?q=<text>:relevance&limit=<n>` -> JSON `{ results, pagination }` */
  search: '/online/he/search/results',
  /** -> mini-cart HTML */
  cartLoad: '/online/he/cart/load?restoreCart=true',
  /** -> cart summary page HTML; carries the site's own "to pay" total and savings (captured) */
  cartSummary: '/online/he/cart/cartsummary',
  /**
   * POST form `quantity=<n>&CSRFToken=<t>`, with entryNumber / qty /
   * sellingMethod / cartContext in the query (captured). qty=0 with
   * cartContext[action]=remove removes the line. Entry numbers shift after a
   * removal, so they must always come from a fresh cart read.
   */
  cartUpdate: '/online/he/cart/update',
  /** -> JSON array of saved addresses; used only as a "signed in?" probe, never printed */
  addressList: '/online/he/checkout/address/list',
  /** -> JSON `{ "YYYYMMDD": RawSlot[] }` for the account's default address. Query copied from the capture. */
  deliverySlots: '/online/he/timeSlot/preselection/getHomeDeliverySlots?amount=1.0&prescription=false',
  /** -> JSON RawSlot; every field null / code null when nothing is chosen */
  selectedSlot: '/online/he/timeSlot/preselection/getSelectedTimeslot',
  /** POST `{ homeDeliveryTimeSlot: RawSlot }` (the slot object exactly as listed), `csrftoken` header -> `true` */
  selectSlot: '/online/he/timeSlot/preselection/postHomeDeliverySlot',
  /** -> JSON `{ activeOrders, closedOrders }` (captured) */
  orders: '/online/he/my-account/orders',
  /** + order code -> JSON order with `entries[]` (captured) */
  orderDetail: '/online/he/my-account/orders/',
  /** -> JSON array of the account's saved lists, no items (captured) */
  savedLists: '/online/he/wishlist/getUserWishlists',
  /** + list id -> JSON list with `entries[]` (from the site's JS; shape verified live 2026-10) */
  savedList: '/online/he/wishlist/getWishlist?listId=',
  /** POST JSON array of items, `csrftoken` header -> mini-cart HTML. The site's own "add all to cart" (captured). */
  cartAddBulk: '/online/he/cart/addGrid?cartContext%5BopenFrom%5D=LIST&cartContext%5BrecommendationType%5D=REGULAR',
} as const;

/** A past order, as listed. */
export type OrderSummary = {
  code: string;
  /** "2026-03-02 10:15" */
  created: string;
  total: number | null;
  itemCount: number | null;
};

export type SavedListSummary = { id: string; name: string; itemCount: number | null };

/** One product from a past order or a saved list. */
export type SourceItem = {
  code: string;
  name: string;
  /** Units for BY_UNIT. For other methods the site's number is not units (e.g. grams), so it is not used. */
  quantity: number;
  sellingMethod: string | null;
  outOfStock: boolean;
};

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export function parseOrders(body: unknown): OrderSummary[] {
  const b = obj(body);
  const all = [...(Array.isArray(b['activeOrders']) ? b['activeOrders'] : []), ...(Array.isArray(b['closedOrders']) ? b['closedOrders'] : [])];
  return all
    .map((o) => {
      const r = obj(o);
      const code = str(r['code']);
      const created = str(r['createdString'])?.replace(/\//g, '-') ?? null;
      if (!code || !created) return null;
      return { code, created, total: num(obj(r['totalPrice'])['value']), itemCount: num(r['totalItems']) };
    })
    .filter((o): o is OrderSummary => o !== null)
    .sort((a, b) => b.created.localeCompare(a.created));
}

/** Order detail: `entries[].{ quantity, product: { code, name, sellingMethod: { code }, stock } }` (captured). */
export function parseOrderItems(body: unknown): SourceItem[] {
  const entries = obj(body)['entries'];
  if (!Array.isArray(entries)) return [];
  return entries
    .map((e) => {
      const entry = obj(e);
      const product = obj(entry['product']);
      const code = str(product['code']);
      // Delivery fees are order lines too ("משלוח שופרסל אונליין"), flagged
      // `deliveryItem: true`. The site's own "add all" skips them; so do we.
      if (!code || product['deliveryItem'] === true) return null;
      return {
        code,
        name: str(product['name']) ?? code,
        quantity: num(entry['quantity']) ?? 1,
        sellingMethod: str(obj(product['sellingMethod'])['code']),
        outOfStock: entry['outOfStock'] === true || obj(obj(product['stock'])['stockLevelStatus'])['code'] === 'outOfStock',
      };
    })
    .filter((i): i is SourceItem => i !== null);
}

export function parseSavedLists(body: unknown): SavedListSummary[] {
  if (!Array.isArray(body)) return [];
  return body
    .map((l) => {
      const r = obj(l);
      const id = str(r['shoppingListId']);
      return id ? { id, name: str(r['name']) ?? id, itemCount: num(r['entriesNumber']) } : null;
    })
    .filter((l): l is SavedListSummary => l !== null);
}

/** Saved list: `entries[].{ quantity, unitOfMeasure, product: { productCode, isOutOfStock, product: { name } } }` (verified live). */
export function parseSavedListItems(body: unknown): SourceItem[] {
  const entries = obj(body)['entries'];
  if (!Array.isArray(entries)) return [];
  return entries
    .map((e) => {
      const entry = obj(e);
      const wrapper = obj(entry['product']);
      const inner = obj(wrapper['product']);
      const code = str(wrapper['productCode']) ?? str(inner['code']);
      if (!code || inner['deliveryItem'] === true) return null;
      return {
        code,
        name: str(inner['name']) ?? code,
        quantity: num(entry['quantity']) ?? num(wrapper['quantity']) ?? 1,
        sellingMethod: str(entry['unitOfMeasure']) ?? str(obj(inner['sellingMethod'])['code']),
        outOfStock: wrapper['isOutOfStock'] === true,
      };
    })
    .filter((i): i is SourceItem => i !== null);
}

/**
 * Turns order / saved-list items into an editable list file of pinned codes.
 * Items this tool will not add (sold by weight/package, out of stock) are
 * written as comments so they stay visible without being ordered.
 */
export function toListFile(title: string, items: SourceItem[]): string {
  const lines = [`# ${title}`, '# Edit freely: delete lines, change "x2", add search lines. Then: npm run cart:fill -- <this file>', ''];
  for (const item of items) {
    const note = `# ${item.name}`;
    if (item.sellingMethod && item.sellingMethod !== 'BY_UNIT') {
      lines.push(`# ${item.code}   ${note.slice(2)} - sold ${item.sellingMethod === 'BY_PACKAGE' ? 'by package' : 'by weight'}, add by hand`);
    } else if (item.outOfStock) {
      lines.push(`# ${item.code} x${item.quantity}   ${note.slice(2)} - out of stock right now`);
    } else {
      const qty = Math.max(1, Math.round(item.quantity));
      lines.push(`${`${item.code}${qty > 1 ? ` x${qty}` : ''}`.padEnd(24)}${note}`);
    }
  }
  return lines.join('\n') + '\n';
}

/** One home-delivery window. Kept whole: selecting one posts the object back unchanged. */
export type RawSlot = {
  code?: string | null;
  fromHour?: number | null;
  toHour?: number | null;
  /** "2026/11/01 10:00", Israel time */
  fromHourString?: string | null;
  selectable?: boolean | null;
  price?: { value?: number | null; formattedValue?: string | null } | null;
  [key: string]: unknown;
};

export type Slot = {
  code: string;
  /** "2026-11-01 10:00", Israel time - the key you pick a slot by */
  start: string;
  /** "12:00" */
  endTime: string;
  selectable: boolean;
  priceText: string | null;
  raw: RawSlot;
};

const ISRAEL_TIME = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Jerusalem', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

export function toSlot(raw: RawSlot): Slot | null {
  if (!raw.code || !raw.fromHourString) return null;
  const start = raw.fromHourString.trim().replace(/\//g, '-');
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(start)) return null;
  return {
    code: raw.code,
    start,
    endTime: typeof raw.toHour === 'number' ? ISRAEL_TIME.format(new Date(raw.toHour)) : '?',
    selectable: raw.selectable === true,
    priceText: raw.price?.formattedValue ?? null,
    raw,
  };
}

/** Accepts "2026-11-02 14:00", "2026/11/02 14:00" or "2026-11-02T14:00" -> "2026-11-02 14:00". */
export function normalizeStart(input: string): string | null {
  const m = /^(\d{4})[-/](\d{2})[-/](\d{2})[ T](\d{1,2}):(\d{2})$/.exec(input.trim());
  return m ? `${m[1]}-${m[2]}-${m[3]} ${m[4]!.padStart(2, '0')}:${m[5]}` : null;
}

/** Flattens the per-day map, earliest first. */
export function parseSlots(body: unknown): Slot[] {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return [];
  return Object.values(body as Record<string, unknown>)
    .filter(Array.isArray)
    .flat()
    .map((s) => toSlot(s as RawSlot))
    .filter((s): s is Slot => s !== null)
    .sort((a, b) => a.start.localeCompare(b.start));
}

export type RawSearchResult = {
  code?: string;
  /** The product's מקט - the digits of its P_ code (`ean` was always null when checked). */
  sku?: string | null;
  name?: string;
  brandName?: string | null;
  unitDescription?: string | null;
  sellingMethod?: { code?: string | null } | null;
  stock?: { stockLevelStatus?: { code?: string | null } | null } | null;
  price?: { value?: number | null; formattedValue?: string | null } | null;
};

export type RawSearchResponse = {
  results?: RawSearchResult[] | null;
  pagination?: { totalNumberOfResults?: number | null } | null;
};

export type Candidate = {
  code: string;
  /** מקט. Searching for it returns exactly this product (verified live). */
  sku: string | null;
  name: string;
  brand: string | null;
  unitDescription: string | null;
  /** `BY_UNIT` is the only method this tool adds automatically. */
  sellingMethod: string | null;
  inStock: boolean;
  price: number | null;
  priceText: string | null;
};

/** "P_4131074" -> "4131074". Some variant codes carry a suffix ("P_7296073409458_40"); the מקט is the first number. */
export function skuOf(code: string): string | null {
  return /^P_(\d+)/i.exec(code)?.[1] ?? null;
}

export function toCandidate(raw: RawSearchResult): Candidate | null {
  if (!raw.code || !raw.name) return null;
  const stock = raw.stock?.stockLevelStatus?.code ?? null;
  return {
    code: raw.code,
    sku: raw.sku?.trim() || skuOf(raw.code),
    name: raw.name.trim(),
    brand: raw.brandName?.trim() || null,
    unitDescription: raw.unitDescription?.trim() || null,
    sellingMethod: raw.sellingMethod?.code ?? null,
    // Seen live: "inStock". Treat only an explicit out-of-stock as unavailable.
    inStock: stock !== 'outOfStock',
    price: typeof raw.price?.value === 'number' ? raw.price.value : null,
    priceText: raw.price?.formattedValue ?? null,
  };
}

export type CartLine = {
  /** Position in the cart. Changes when lines are removed - never reuse a stale one. */
  entryNumber: number;
  code: string;
  name: string;
  quantity: number;
  /** "BY_UNIT", "BY_PACKAGE", "BY_WEIGHT" */
  sellingMethod: string | null;
  /** Line total as the site shows it (before cart-level promotions). */
  lineTotal: number | null;
};

export type CartSummary = {
  /** The site's own "סה"כ לתשלום" figure on the cart summary page. */
  toPay: number | null;
  /** The site's own "סה"כ חסכת" figure. */
  savings: number | null;
  itemCount: number | null;
};

const ENTITIES: Record<string, string> = { '&amp;': '&', '&quot;': '"', '&#034;': '"', '&#039;': "'", '&#39;': "'", '&lt;': '<', '&gt;': '>', '&nbsp;': ' ' };
const decode = (s: string) => s.replace(/&(?:amp|quot|lt|gt|nbsp|#034|#039|#39);/g, (m) => ENTITIES[m] ?? m);
const money = (s: string | undefined) => (s === undefined ? null : Number.parseFloat(s.replace(/,/g, '')));

/**
 * Cart lines from mini-cart HTML (cart/load, cart/update, cart/addGrid all
 * return it). Each line is an `<article ... data-product-code data-entry-number
 * data-entry-qty>` with the name in `.miglog-prod-name a` and the line total in
 * `.miglog-prod-totalPrize` (confirmed in the capture).
 */
export function parseCartLines(html: string): CartLine[] {
  const heads = [...html.matchAll(/<article class="([^"]*)"[^>]*>/g)].filter((m) => /data-product-code=/.test(m[0]));
  return heads.map((head, k) => {
    const tag = head[0];
    const attr = (name: string) => new RegExp(`\\b${name}="([^"]*)"`).exec(tag)?.[1];
    const block = html.slice(head.index, heads[k + 1]?.index ?? head.index + 30000);
    // Usually a class on the article; for some lines only the quantity input carries it.
    const method = /miglog-sellingmethod-(by_[a-z]+)/.exec(head[1] ?? '')?.[1] ?? /data-miglog-sellingmethod\s*=\s*"(BY_[A-Z]+)"/.exec(block)?.[1];
    return {
      entryNumber: Number.parseInt(attr('data-entry-number') ?? '-1', 10),
      code: attr('data-product-code') ?? '',
      name: decode(/miglog-prod-name[\s\S]*?<a[^>]*>([^<]+)<\/a>/.exec(block)?.[1]?.trim() ?? ''),
      quantity: Number.parseFloat(attr('data-entry-qty') ?? '0'),
      sellingMethod: method ? method.toUpperCase() : null,
      lineTotal: money(/miglog-prod-totalPrize[^>]*>\s*([\d.,]+)/.exec(block)?.[1]),
    };
  }).filter((l) => l.code !== '' && l.entryNumber >= 0);
}

/** The total / savings / item count printed on the cart summary page. */
export function parseCartSummary(html: string): CartSummary {
  const text = decode(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ');
  return {
    toPay: money(/miglog-cart-summary-totalprice">\s*([\d.,]+)/.exec(html)?.[1]),
    savings: money(/סה[”"״]כ חסכת:\s*(?:₪\s*)?(?:שקלים חדשים\s*)?([\d.,]+)/.exec(text)?.[1]),
    itemCount: money(/id="cartTotalItems">\s*(\d+)/.exec(html)?.[1]),
  };
}

/**
 * The cart endpoints answer with mini-cart HTML. Each line item carries
 * `data-product-code="P_..." data-entry-number=".." data-entry-qty="1.0"` on
 * one element (confirmed in the capture) - that is what we read back to
 * confirm an add actually landed.
 */
export function parseCartEntries(html: string): Map<string, number> {
  const entries = new Map<string, number>();
  const tag = /<[^>]*\bdata-product-code="([^"]+)"[^>]*>/g;
  for (const match of html.matchAll(tag)) {
    const qty = /\bdata-entry-qty="([\d.]+)"/.exec(match[0]);
    if (!qty) continue;
    entries.set(match[1]!, Number.parseFloat(qty[1]!));
  }
  return entries;
}
