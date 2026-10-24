import { MAX_QUANTITY } from '../list/parse-list.js';
import { FormBody, SessionError, type Transport } from './transport.js';
import {
  ENDPOINTS,
  parseCartEntries,
  parseCartLines,
  parseCartSummary,
  type CartLine,
  type CartSummary,
  parseOrderItems,
  parseOrders,
  parseSavedListItems,
  parseSavedLists,
  parseSlots,
  toCandidate,
  toSlot,
  type Candidate,
  type OrderSummary,
  type RawSearchResponse,
  type RawSlot,
  type SavedListSummary,
  type Slot,
  type SourceItem,
} from './types.js';

/**
 * Search, read the cart, add to the cart, and choose a delivery window.
 * There is intentionally no checkout or payment call here - the order is
 * always reviewed and placed by you in the Shufersal app or site. Choosing a
 * delivery window only pre-selects it for the cart; it does not order.
 */
export class ShufersalClient {
  constructor(private readonly session: Transport) {}

  async search(query: string, limit = 10): Promise<Candidate[]> {
    const q = encodeURIComponent(`${query}:relevance`);
    const response = await this.session.request('GET', `${ENDPOINTS.search}?q=${q}&limit=${limit}`);
    if (response.status !== 200 || !response.contentType.includes('json')) {
      throw new SessionError(`search returned HTTP ${response.status} (${response.contentType || 'no content type'}) - signed out?`);
    }
    const body = JSON.parse(response.text) as RawSearchResponse;
    if (!Array.isArray(body.results)) throw new SessionError('search response has no "results" array');
    return body.results.map(toCandidate).filter((c): c is Candidate => c !== null);
  }

  /**
   * Exact lookup by מקט: searching for the number returns that product (verified
   * live). Only a result whose sku is exactly the number counts - never a
   * "close" match.
   */
  async findBySku(sku: string): Promise<Candidate | null> {
    if (!/^\d{4,14}$/.test(sku)) throw new SessionError(`Not a מקט: ${sku}`);
    return (await this.search(sku, 5)).find((c) => c.sku === sku) ?? null;
  }

  /** Every line in the cart with name, quantity, selling method and line price. */
  async cartLines(): Promise<CartLine[]> {
    const response = await this.session.request('GET', ENDPOINTS.cartLoad);
    if (response.status !== 200) throw new SessionError(`cart/load returned HTTP ${response.status}`);
    return parseCartLines(response.text);
  }

  /** The site's own "to pay" total and savings, from the cart summary page. */
  async cartSummary(): Promise<CartSummary> {
    const response = await this.session.request('GET', ENDPOINTS.cartSummary);
    if (response.status !== 200) throw new SessionError(`cart/cartsummary returned HTTP ${response.status}`);
    return parseCartSummary(response.text);
  }

  /**
   * Sets a product's quantity; 0 removes it. The entry number is looked up in
   * a fresh cart read right before the request (it shifts after removals), and
   * the result is checked against the cart the site returns.
   */
  async setQuantity(code: string, qty: number): Promise<CartLine[]> {
    if (!Number.isInteger(qty) || qty < 0 || qty > MAX_QUANTITY) {
      throw new SessionError(`Quantity must be a whole number from 0 to ${MAX_QUANTITY}, got ${qty}.`);
    }
    const line = (await this.cartLines()).find((l) => l.code === code);
    if (!line) throw new SessionError(`${code} is not in the cart.`);
    const remove = qty === 0;
    if (!remove && line.sellingMethod !== 'BY_UNIT') {
      throw new SessionError(`${line.name} is sold ${line.sellingMethod ?? 'by weight'} - change its amount in the app; only removing it is supported here.`);
    }

    // Query mirrors the captured requests exactly, including parameter order.
    const query = new URLSearchParams();
    query.set('entryNumber', String(line.entryNumber));
    query.set('qty', String(qty));
    query.set('sellingMethod', remove ? '' : 'BY_UNIT');
    if (!remove) query.set('comment', '');
    query.set('cartContext[openFrom]', 'CART');
    query.set('cartContext[recommendationType]', 'REGULAR');
    if (remove) query.set('cartContext[action]', 'remove');

    const response = await this.session.request('POST', `${ENDPOINTS.cartUpdate}?${query}`, new FormBody({ quantity: String(qty) }));
    if (response.status !== 200) throw new SessionError(`cart/update returned HTTP ${response.status}`);

    const after = parseCartLines(response.text);
    const now = after.find((l) => l.code === code);
    if (remove ? now !== undefined : now?.quantity !== qty) {
      throw new SessionError(`The site did not apply the change to ${line.name} (now: ${now ? now.quantity : 'not in cart'}). Check the cart.`);
    }
    return after;
  }

  /** Product code -> quantity currently in the cart. */
  async cart(): Promise<Map<string, number>> {
    const response = await this.session.request('GET', ENDPOINTS.cartLoad);
    if (response.status !== 200) throw new SessionError(`cart/load returned HTTP ${response.status}`);
    return parseCartEntries(response.text);
  }

  /**
   * Adds several products in one request - the same call as the site's own
   * "add all to cart". Returns the cart quantities from the returned cart, so
   * each item can be checked individually.
   */
  async addBulk(items: Array<{ code: string; qty: number }>): Promise<Map<string, number>> {
    const response = await this.session.request(
      'POST',
      ENDPOINTS.cartAddBulk,
      items.map((i) => ({ productCode: i.code, frontQuantity: i.qty, quantity: i.qty, sellingMethod: 'BY_UNIT', comment: '', longTail: false })),
    );
    if (response.status !== 200) throw new SessionError(`cart/addGrid returned HTTP ${response.status}`);
    return parseCartEntries(response.text);
  }

  async orders(): Promise<OrderSummary[]> {
    return parseOrders(await this.json('GET', ENDPOINTS.orders));
  }

  async orderItems(code: string): Promise<SourceItem[]> {
    if (!/^\d+$/.test(code)) throw new SessionError(`Not an order code: ${code}`);
    return parseOrderItems(await this.json('GET', ENDPOINTS.orderDetail + code));
  }

  async savedLists(): Promise<SavedListSummary[]> {
    return parseSavedLists(await this.json('GET', ENDPOINTS.savedLists));
  }

  async savedListItems(id: string): Promise<SourceItem[]> {
    if (!/^\d+$/.test(id)) throw new SessionError(`Not a list id: ${id}`);
    return parseSavedListItems(await this.json('GET', ENDPOINTS.savedList + id));
  }

  /** Home-delivery windows for the account's default address, earliest first. */
  async deliverySlots(): Promise<Slot[]> {
    return parseSlots(await this.json('GET', ENDPOINTS.deliverySlots));
  }

  /** The window currently chosen for the cart, or null when none is. */
  async selectedSlot(): Promise<Slot | null> {
    return toSlot((await this.json('GET', ENDPOINTS.selectedSlot)) as RawSlot);
  }

  /** Pre-selects a window. Returns the site's own yes/no. */
  async selectSlot(slot: Slot): Promise<boolean> {
    return (await this.json('POST', ENDPOINTS.selectSlot, { homeDeliveryTimeSlot: slot.raw })) === true;
  }

  private async json(method: 'GET' | 'POST', apiPath: string, body?: unknown): Promise<unknown> {
    const response = await this.session.request(method, apiPath, body);
    if (response.status !== 200 || !response.contentType.includes('json')) {
      throw new SessionError(`${apiPath} returned HTTP ${response.status} (${response.contentType || 'no content type'})`);
    }
    return JSON.parse(response.text) as unknown;
  }
}
