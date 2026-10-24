import { decide } from '../list/match.js';
import type { Choices } from '../list/choices.js';
import type { ListItem } from '../list/parse-list.js';
import type { ShufersalClient } from '../shufersal/client.js';
import { BlockedError, SessionError } from '../shufersal/transport.js';
import type { Candidate } from '../shufersal/types.js';

/**
 * List lines -> cart, shared by the `cart:fill` CLI and the MCP server.
 *
 * Pass 1 resolves every line to one product (pinned P_ code, or a search that
 * must be unambiguous). Pass 2 adds everything in one bulk request - the
 * site's own "add all to cart" - and confirms each product against the cart
 * the site returns. Nothing here checks out or pays.
 */

/** A pinned P_ code has no search result behind it, so only the code is known. */
export type Product = Candidate | { code: string; name?: undefined };
/** How a line was turned into a product, when it was not a plain search. */
export type Via = 'code' | 'sku' | 'remembered';
/** Resolved and waiting for the bulk add (or, in a dry run, what would be added). */
export type Queued = { status: 'would-add'; item: ListItem; product: Product; via?: Via };

export type Outcome =
  | Queued
  | { status: 'added'; item: ListItem; product: Product; cartQty: number; via?: Via }
  | { status: 'already-in-cart'; item: ListItem; code: string; cartQty: number; name?: string }
  | { status: 'ambiguous' | 'out-of-stock'; item: ListItem; candidates: Candidate[] }
  | { status: 'not-found'; item: ListItem }
  | { status: 'by-weight'; item: ListItem; product: Candidate }
  | { status: 'unverified'; item: ListItem; code: string }
  | { status: 'duplicate'; item: ListItem; code: string; line: number }
  | { status: 'error'; item: ListItem; message: string };

export type FillResult = {
  dryRun: boolean;
  outcomes: Outcome[];
  /** Set when the run stopped part-way (session lost, site refused). */
  stoppedEarly: string | null;
};

export type FillOptions = {
  dryRun: boolean;
  /** Pause between search requests, in ms. */
  delayMs: number;
  pause: (ms: number) => Promise<void>;
  /** Remembered "this line means this product" choices; looked up before searching. */
  choices?: Choices;
  /** Called as each line is resolved, and again when the bulk add settles it. */
  onOutcome?: (outcome: Outcome) => void;
  /** Called just before the bulk add request. */
  onBulkAdd?: (count: number) => void;
};

export async function fillCart(client: ShufersalClient, items: ListItem[], options: FillOptions): Promise<FillResult> {
  const outcomes: Outcome[] = [];
  const report = (o: Outcome) => options.onOutcome?.(o);

  try {
    const cart = await client.cart();

    const queued = new Map<string, Queued>();
    for (const item of items) {
      let outcome: Outcome;
      try {
        outcome = await resolve(item, client, cart, queued, options.choices);
      } catch (error) {
        if (error instanceof BlockedError) throw error;
        outcome = { status: 'error', item, message: error instanceof Error ? error.message : String(error) };
      }
      outcomes.push(outcome);
      report(outcome);
      if (!item.productCode) await options.pause(options.delayMs);
    }

    if (!options.dryRun && queued.size > 0) {
      options.onBulkAdd?.(queued.size);
      const after = await client.addBulk([...queued.values()].map((o) => ({ code: o.product.code, qty: o.item.quantity })));
      for (const [code, pending] of queued) {
        const cartQty = after.get(code);
        const done: Outcome =
          cartQty === undefined
            ? { status: 'unverified', item: pending.item, code }
            : { status: 'added', item: pending.item, product: pending.product, cartQty, ...(pending.via ? { via: pending.via } : {}) };
        outcomes[outcomes.indexOf(pending)] = done;
        report(done);
      }
    }
    return { dryRun: options.dryRun, outcomes, stoppedEarly: null };
  } catch (error) {
    if (!(error instanceof SessionError)) throw error;
    return { dryRun: options.dryRun, outcomes, stoppedEarly: error.message };
  }
}

async function resolve(
  item: ListItem,
  client: ShufersalClient,
  cart: Map<string, number>,
  queued: Map<string, Queued>,
  choices?: Choices,
): Promise<Outcome> {
  let product: Product;
  let via: Via | undefined;

  // An explicit מקט, or a product the user chose for this line before: exact
  // lookup by מקט, with live price and stock - never a fuzzy match.
  const remembered = item.sku || item.productCode ? undefined : choices?.get(item.query);
  const sku = item.sku ?? remembered?.sku;

  if (item.productCode) {
    product = { code: item.productCode };
    via = 'code';
  } else if (sku) {
    via = item.sku ? 'sku' : 'remembered';
    const found = await client.findBySku(sku);
    if (!found) {
      return { status: 'error', item, message: `no product with מקט ${sku}${remembered ? ` (remembered for "${remembered.query}" - choose again)` : ''}` };
    }
    if (!found.inStock) return { status: 'out-of-stock', item, candidates: [found] };
    if (found.sellingMethod && found.sellingMethod !== 'BY_UNIT') return { status: 'by-weight', item, product: found };
    product = found;
  } else {
    const decision = decide(item.query, await client.search(item.query));
    if (decision.kind === 'none') return { status: 'not-found', item };
    if (decision.kind === 'ambiguous' || decision.kind === 'out-of-stock') {
      return { status: decision.kind, item, candidates: decision.candidates };
    }
    if (decision.pick.sellingMethod && decision.pick.sellingMethod !== 'BY_UNIT') {
      // Weighed produce: the quantity semantics (units vs. kg) were never
      // observed in a capture, so it is not automated.
      return { status: 'by-weight', item, product: decision.pick };
    }
    product = decision.pick;
  }

  // Re-running a list must not double the order.
  const existing = cart.get(product.code);
  if (existing !== undefined) {
    return { status: 'already-in-cart', item, code: product.code, cartQty: existing, name: product.name };
  }

  const earlier = queued.get(product.code);
  if (earlier) return { status: 'duplicate', item, code: product.code, line: earlier.item.line };

  const outcome: Queued = { status: 'would-add', item, product, ...(via ? { via } : {}) };
  queued.set(product.code, outcome);
  return outcome;
}

export function label(c: Candidate): string {
  return [c.name, c.brand, c.priceText].filter(Boolean).join(' · ') + `  [${c.code}]`;
}

export function describe(o: Outcome): string {
  // Pinned codes are unreadable on their own; show the list line's note (the
  // product name written by `history`) instead.
  const head = o.item.productCode && o.item.note ? `${o.item.note}${o.item.quantity > 1 ? ` x${o.item.quantity}` : ''}` : o.item.raw;
  const what = (p: Product) => ('priceText' in p ? label(p) : `[${p.code}]`);
  switch (o.status) {
    case 'added':
      return `  ✓ ${head}  ->  ${what(o.product)}  (in cart: ${o.cartQty})${o.via === 'remembered' ? '  [your earlier choice]' : ''}`;
    case 'would-add':
      return `  ~ ${head}  ->  ${what(o.product)}  x${o.item.quantity}${o.via === 'remembered' ? '  [your earlier choice]' : ''}`;
    case 'already-in-cart':
      return `  = ${head}  ->  already in cart (${o.cartQty})  [${o.code}]`;
    case 'ambiguous':
      return (
        `  ? ${head}  ->  ambiguous, not added. Choose one (remembered for next time):\n` +
        o.candidates.map((c) => `        ${label(c)}`).join('\n') +
        `\n        npm run choose -- "${o.item.query}" ${o.candidates[0]?.code ?? 'P_…'}`
      );
    case 'out-of-stock':
      return `  ✗ ${head}  ->  only out-of-stock matches:\n` + o.candidates.map((c) => `        ${label(c)}`).join('\n');
    case 'not-found':
      return `  ✗ ${head}  ->  nothing found`;
    case 'by-weight':
      return `  ⚖ ${head}  ->  ${label(o.product)} is sold by weight - add it by hand`;
    case 'unverified':
      return `  ! ${head}  ->  add request sent for ${o.code}, but it does not appear in the returned cart - check it`;
    case 'duplicate':
      return `  ! ${head}  ->  same product as line ${o.line} [${o.code}] - only the first line is used`;
    case 'error':
      return `  ! ${head}  ->  error: ${o.message}`;
  }
}

export function summarize(result: FillResult, total: number): string {
  const count = (s: Outcome['status']) => result.outcomes.filter((o) => o.status === s).length;
  const needsYou =
    count('ambiguous') + count('out-of-stock') + count('not-found') + count('by-weight') + count('unverified') + count('duplicate') + count('error');
  const head = result.dryRun ? `Would add ${count('would-add')} of ${total}.` : `Added ${count('added')} of ${total}.`;
  return [result.stoppedEarly ? `STOPPED EARLY: ${result.stoppedEarly}` : null, `${head} Already in cart: ${count('already-in-cart')}. Needs you: ${needsYou}.`]
    .filter(Boolean)
    .join('\n');
}
