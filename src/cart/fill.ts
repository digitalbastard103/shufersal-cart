import { decide } from '../list/match.js';
import type { Choices } from '../list/choices.js';
import { MAX_QUANTITY, MAX_WEIGHT_KG, type ListItem } from '../list/parse-list.js';
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
/**
 * `total` is the amount sent for this product, summed over duplicate lines:
 * units or packs, or kg when `sellingMethod` is BY_WEIGHT. `refused` blocks the whole group.
 */
export type Queued = { status: 'would-add'; item: ListItem; product: Product; via?: Via; total: number; sellingMethod: SellingMethod; refused?: string };
export type SellingMethod = 'BY_UNIT' | 'BY_PACKAGE' | 'BY_WEIGHT';

export type Outcome =
  | Queued
  | { status: 'added'; item: ListItem; product: Product; cartQty: number; total: number; sellingMethod: SellingMethod; via?: Via }
  | { status: 'already-in-cart'; item: ListItem; code: string; cartQty: number; name?: string }
  | { status: 'ambiguous' | 'out-of-stock'; item: ListItem; candidates: Candidate[] }
  | { status: 'not-found'; item: ListItem }
  | { status: 'by-weight'; item: ListItem; product: Candidate }
  | { status: 'unverified'; item: ListItem; code: string }
  | { status: 'merged'; item: ListItem; code: string; line: number; total: number }
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
      await options.pause(options.delayMs);
    }

    // A product whose lines together exceed the limit is not added at all.
    for (const [code, pending] of queued) {
      if (!pending.refused) continue;
      outcomes[outcomes.indexOf(pending)] = { status: 'error', item: pending.item, message: pending.refused };
      queued.delete(code);
    }

    if (!options.dryRun && queued.size > 0) {
      options.onBulkAdd?.(queued.size);
      const after = await client.addBulk([...queued.values()].map((o) => ({ code: o.product.code, qty: o.total, sellingMethod: o.sellingMethod })));
      for (const [code, pending] of queued) {
        const cartQty = after.get(code);
        const done: Outcome =
          cartQty === undefined
            ? { status: 'unverified', item: pending.item, code }
            : { status: 'added', item: pending.item, product: pending.product, cartQty, total: pending.total, sellingMethod: pending.sellingMethod, ...(pending.via ? { via: pending.via } : {}) };
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
    // A pinned code gets the same checks as any other line: it must exist, be
    // in stock and be sold by unit. Products already in the cart need no lookup.
    const inCart = cart.get(item.productCode);
    if (inCart !== undefined) return { status: 'already-in-cart', item, code: item.productCode, cartQty: inCart, name: item.note };
    const found = await client.findByCode(item.productCode);
    if (!found) return { status: 'not-found', item };
    if (!found.inStock) return { status: 'out-of-stock', item, candidates: [found] };
    product = found;
    via = 'code';
  } else if (sku) {
    via = item.sku ? 'sku' : 'remembered';
    const found = await client.findBySku(sku);
    if (!found) {
      return { status: 'error', item, message: `no product with מקט ${sku}${remembered ? ` (remembered for "${remembered.query}" - choose again)` : ''}` };
    }
    if (!found.inStock) return { status: 'out-of-stock', item, candidates: [found] };
    product = found;
  } else {
    const decision = decide(item.query, await client.search(item.query));
    if (decision.kind === 'none') return { status: 'not-found', item };
    if (decision.kind === 'ambiguous' || decision.kind === 'out-of-stock') {
      return { status: decision.kind, item, candidates: decision.candidates };
    }
    product = decision.pick;
  }

  // How much to send, by the product's selling method (verified live: packs go
  // through the bulk add, weights only through the single add, in kg).
  const amount = amountFor(item, product);
  if ('status' in amount) return amount;

  // Re-running a list must not double the order.
  const existing = cart.get(product.code);
  if (existing !== undefined) {
    return { status: 'already-in-cart', item, code: product.code, cartQty: existing, name: product.name };
  }

  // The same product on several lines: the quantities add up, like a shopping list.
  const earlier = queued.get(product.code);
  if (earlier) {
    if (earlier.sellingMethod !== amount.sellingMethod) {
      return { status: 'error', item, message: `line ${earlier.item.line} asks for this product by ${earlier.sellingMethod === 'BY_WEIGHT' ? 'weight' : 'unit'}; use one or the other` };
    }
    const total = round3(earlier.total + amount.amount);
    const limit = amount.sellingMethod === 'BY_WEIGHT' ? amount.max : MAX_QUANTITY;
    if (earlier.refused || total > limit) {
      earlier.refused ??= `lines with this product add up to ${total} ${amount.sellingMethod === 'BY_WEIGHT' ? 'kg' : 'units'}, more than ${limit}; none of them was added`;
      return { status: 'error', item, message: earlier.refused };
    }
    earlier.total = total;
    return { status: 'merged', item, code: product.code, line: earlier.item.line, total };
  }

  const outcome: Queued = { status: 'would-add', item, product, total: amount.amount, sellingMethod: amount.sellingMethod, ...(via ? { via } : {}) };
  queued.set(product.code, outcome);
  return outcome;
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

/**
 * The amount to send for a line: whole units for BY_UNIT, whole packs for
 * BY_PACKAGE, and for BY_WEIGHT the line's weight in kg, which must be a
 * multiple of the product's step (500 g seen live) and within its ceiling.
 * A weighed product without a weight is left to the user, as before.
 */
function amountFor(item: ListItem, product: Product): { sellingMethod: SellingMethod; amount: number; max: number } | Outcome {
  const method = 'sellingMethod' in product ? product.sellingMethod : null;
  const candidate = 'sellingMethod' in product ? (product as Candidate) : null;
  const weighed = method === 'BY_WEIGHT' || (method === 'CUSTOMER_SELECTION' && item.weightKg !== undefined);
  if (!weighed) {
    if (item.weightKg !== undefined) return { status: 'error', item, message: `${product.name ?? product.code} is sold by ${method === 'BY_PACKAGE' ? 'pack' : 'unit'}; give a number of ${method === 'BY_PACKAGE' ? 'packs' : 'units'} (x2), not a weight` };
    if (!Number.isInteger(item.quantity)) return { status: 'error', item, message: 'quantity must be a whole number' };
    return { sellingMethod: method === 'BY_PACKAGE' ? 'BY_PACKAGE' : 'BY_UNIT', amount: item.quantity, max: MAX_QUANTITY };
  }
  if (item.weightKg === undefined) return { status: 'by-weight', item, product: candidate as Candidate };
  const step = candidate?.weightStepKg ?? 0.5;
  const max = Math.min(candidate?.maxWeightKg ?? MAX_WEIGHT_KG, MAX_WEIGHT_KG);
  const steps = item.weightKg / step;
  if (Math.abs(steps - Math.round(steps)) > 1e-6 || item.weightKg < step) {
    return { status: 'error', item, message: `${product.name ?? product.code} is sold in steps of ${step} kg; ask for ${Math.max(step, Math.round(steps) * step)} kg, for example` };
  }
  if (item.weightKg > max) return { status: 'error', item, message: `at most ${max} kg of ${product.name ?? product.code}` };
  return { sellingMethod: 'BY_WEIGHT', amount: round3(item.weightKg), max };
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
      return `  ~ ${head}  ->  ${what(o.product)}  ${o.sellingMethod === 'BY_WEIGHT' ? `${o.total} kg` : `x${o.total}`}${o.via === 'remembered' ? '  [your earlier choice]' : ''}`;
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
      return `  ⚖ ${head}  ->  ${label(o.product)} is sold by weight - give a weight, e.g. 1.5 ק"ג`;
    case 'unverified':
      return `  ! ${head}  ->  add request sent for ${o.code}, but it does not appear in the returned cart - check it`;
    case 'merged':
      return `  + ${head}  ->  same product as line ${o.line} [${o.code}] - added to it (x${o.total} in total)`;
    case 'error':
      return `  ! ${head}  ->  error: ${o.message}`;
  }
}

/** Lines left out before filling: from an order or list (`skipped`), or unparseable list lines (`invalid`). */
export type Tally = { skipped?: number; invalid?: number };

/** Counts over every requested line, including those that never reached the cart. */
export function counts(result: FillResult, lines: number, { skipped = 0, invalid = 0 }: Tally = {}) {
  const count = (s: Outcome['status']) => result.outcomes.filter((o) => o.status === s).length;
  const needsAttention =
    count('ambiguous') + count('out-of-stock') + count('not-found') + count('by-weight') + count('unverified') + count('error') + skipped + invalid;
  return {
    requestedLines: lines + skipped + invalid,
    ...(result.dryRun ? { wouldAdd: count('would-add') } : { added: count('added') }),
    alreadyInCart: count('already-in-cart'),
    merged: count('merged'),
    needsAttention,
    skipped,
    invalid,
    complete: needsAttention === 0 && !result.stoppedEarly,
  };
}

export function summarize(result: FillResult, total: number, tally: Tally = {}): string {
  const c = counts(result, total, tally);
  const done = result.outcomes.filter((o) => o.status === (result.dryRun ? 'would-add' : 'added')).length;
  const head = result.dryRun ? `Would add ${done} of ${c.requestedLines}.` : `Added ${done} of ${c.requestedLines}.`;
  const merged = c.merged ? ` Merged duplicates: ${c.merged}.` : '';
  return [result.stoppedEarly ? `STOPPED EARLY: ${result.stoppedEarly}` : null, `${head} Already in cart: ${c.alreadyInCart}.${merged} Needs you: ${c.needsAttention}.`]
    .filter(Boolean)
    .join('\n');
}
