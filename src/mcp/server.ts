import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { fillCart, summarize, type FillResult, type Outcome } from '../cart/fill.js';
import { loadConfig, loadDotEnv, type ShoppingConfig } from '../config.js';
import { MAX_QUANTITY, parseList, type ListItem } from '../list/parse-list.js';
import { ShufersalClient } from '../shufersal/client.js';
import { connect, hasCredentials, login } from '../shufersal/connect.js';
import { NotSignedInError, SessionError, type Transport } from '../shufersal/transport.js';
import { normalizeStart, skuOf, type SourceItem } from '../shufersal/types.js';
import { Choices } from '../list/choices.js';

/**
 * MCP server: lets an AI assistant build and edit the user's Shufersal cart.
 *
 * It never checks out or pays - the user pays in the Shufersal app or site.
 * It never opens a browser on its own: only the explicit `login` tool does.
 * stdout carries the MCP protocol, so all logging goes to stderr.
 */

const INSTRUCTIONS = `
Shufersal (Israeli supermarket) online-cart tools. They build and edit the user's
real cart. They NEVER check out or pay: when the cart is ready, tell the user the
total and that they finish and pay in the Shufersal app or website.

Typical flow: status -> (login, only if not signed in) -> build the cart
(fill_cart_from_list, add_order_to_cart, add_saved_list_to_cart, add_to_cart)
-> view_cart -> set_quantity / remove_from_cart -> list_delivery_slots ->
choose_delivery_slot -> report the total.

Rules:
- Ambiguous list lines are never guessed. Show the user the candidates and ask
  which product they want, then add it by its P_ code with add_to_cart, passing
  remember_as = the original line, so the same line resolves to that product
  automatically next time (or call remember_choice).
- Items sold by weight or package are not added automatically; tell the user to
  add those in the app.
- Before adding a whole past order or saved list, use dry_run and confirm with
  the user. Never choose a delivery window the user did not ask for.
- Totals are Shufersal's own figures. Product names are Hebrew; search in Hebrew.
`.trim();

const productCode = z.string().regex(/^P_\d+$/i, 'a Shufersal product code like P_4131074').transform((s) => s.toUpperCase());
const quantity = z.number().int().min(1).max(MAX_QUANTITY);
const dryRun = z.boolean().default(false).describe('Only report what would be added; change nothing.');

class Shop {
  private session: Transport | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    readonly config: ShoppingConfig,
    private readonly log: (m: string) => void,
  ) {}

  /** Runs one tool call against the site. Calls are serialized: cart edits depend on fresh entry numbers. */
  run<T>(fn: (client: ShufersalClient, session: Transport) => Promise<T>): Promise<T> {
    const next = this.queue.then(async () => {
      // Saved session, else the stored username/password if configured - never a browser.
      const session = this.session ?? (this.session = await connect(this.config, this.log, { allowBrowserLogin: false }));
      try {
        return await fn(new ShufersalClient(session), session);
      } catch (error) {
        // Any site-level failure may mean the session died; re-check it next call.
        if (error instanceof SessionError) this.session = null;
        throw error;
      } finally {
        await session.close(); // persists renewed cookies; the session stays usable
      }
    });
    this.queue = next.catch(() => {});
    return next;
  }

  signIn(): Promise<void> {
    const next = this.queue.then(async () => {
      this.session = await login(this.config, this.log);
    });
    this.queue = next.catch(() => {});
    return next;
  }

  /** Probes without throwing. */
  async signedIn(): Promise<boolean> {
    try {
      await this.run(async () => undefined);
      return true;
    } catch (error) {
      if (error instanceof NotSignedInError) return false;
      throw error;
    }
  }
}

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

async function respond(fn: () => Promise<unknown>): Promise<ToolResult> {
  try {
    const data = await fn();
    return { content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }] };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const hint =
      error instanceof NotSignedInError
        ? ' Ask the user to log in: the `login` tool (a browser window on the computer running this server, or the stored credentials if the owner configured them), or import a session file (see README).'
        : '';
    return { isError: true, content: [{ type: 'text', text: message + hint }] };
  }
}

/** Fill outcome -> compact JSON for the model. */
function outcomeJson(o: Outcome) {
  const base = { line: o.item.line, input: o.item.note ?? o.item.raw, quantity: o.item.quantity, status: o.status };
  switch (o.status) {
    case 'added':
    case 'would-add':
      return {
        ...base,
        code: o.product.code,
        name: o.product.name ?? o.item.note,
        ...(o.status === 'added' ? { cartQuantity: o.cartQty } : {}),
        ...(o.via === 'remembered' ? { resolvedBy: "the user's earlier choice for this line" } : o.via === 'sku' ? { resolvedBy: 'exact מקט' } : {}),
      };
    case 'already-in-cart':
      return { ...base, code: o.code, cartQuantity: o.cartQty, note: 'left as is; use set_quantity to change it' };
    case 'ambiguous':
    case 'out-of-stock':
      return { ...base, candidates: o.candidates.map((c) => ({ code: c.code, name: c.name, brand: c.brand, price: c.priceText, inStock: c.inStock })) };
    case 'by-weight':
      return { ...base, code: o.product.code, name: o.product.name, note: 'sold by weight - the user adds it in the app' };
    case 'unverified':
      return { ...base, code: o.code, note: 'add request sent but the product is not in the returned cart - check view_cart' };
    case 'duplicate':
      return { ...base, code: o.code, note: `same product as line ${o.line}; only the first is used` };
    case 'not-found':
      return base;
    case 'error':
      return { ...base, error: o.message };
  }
}

function fillJson(result: FillResult, total: number, extra: Record<string, unknown> = {}) {
  return {
    summary: summarize(result, total),
    dryRun: result.dryRun,
    ...extra,
    lines: result.outcomes.map(outcomeJson),
    reminder: 'Nothing was ordered. The user checks out and pays in the Shufersal app or site.',
  };
}

/** Past order / saved list items -> pinned list items; the rest is reported, not added. */
function itemsToList(items: SourceItem[]) {
  const list: ListItem[] = [];
  const skipped: Array<{ code: string; name: string; reason: string }> = [];
  items.forEach((item, i) => {
    if (item.sellingMethod && item.sellingMethod !== 'BY_UNIT') skipped.push({ code: item.code, name: item.name, reason: 'sold by weight/package - add in the app' });
    else if (item.outOfStock) skipped.push({ code: item.code, name: item.name, reason: 'out of stock' });
    else list.push({ line: i + 1, raw: item.code, query: '', productCode: item.code, quantity: Math.min(MAX_QUANTITY, Math.max(1, Math.round(item.quantity))), note: item.name });
  });
  return { list, skipped };
}

function cartView(client: ShufersalClient) {
  return async () => {
    const [lines, summary, slot] = [await client.cartLines(), await client.cartSummary(), await client.selectedSlot()];
    return {
      products: lines.map((l) => ({ code: l.code, name: l.name, quantity: l.quantity, sellingMethod: l.sellingMethod, lineTotal: l.lineTotal })),
      productCount: lines.length,
      toPay: summary.toPay,
      savings: summary.savings,
      deliveryWindow: slot ? `${slot.start}-${slot.endTime}` : null,
      note: 'toPay and savings are Shufersal\'s own figures from its cart summary page.',
    };
  };
}

export function createServer(shop: Shop): McpServer {
  const server = new McpServer({ name: 'shufersal-cart', version: '0.1.0' }, { instructions: INSTRUCTIONS });
  const { config } = shop;
  // Reloaded per call so choices made from the CLI meanwhile are picked up.
  const choices = () => Choices.load(config.choicesFile);
  const fill = (client: ShufersalClient, session: Transport, items: ListItem[], dry: boolean) =>
    fillCart(client, items, { dryRun: dry, choices: choices(), delayMs: config.requestDelayMs, pause: (ms) => session.pause(ms) });

  /** Verifies the product live (exact מקט lookup) before remembering it. */
  const remember = async (client: ShufersalClient, line: string, code: string) => {
    const sku = skuOf(code);
    const found = sku ? await client.findBySku(sku) : null;
    if (!sku || !found) throw new SessionError(`No product ${code} to remember.`);
    return choices().set(line, { code: found.code, sku, name: found.name });
  };

  server.registerTool(
    'status',
    {
      title: 'Session and cart status',
      description: 'Whether the saved Shufersal session works, plus a short cart summary. Call this first.',
      annotations: { readOnlyHint: true },
    },
    () =>
      respond(async () => {
        if (!(await shop.signedIn())) return { signedIn: false, next: 'Ask the user to log in with the `login` tool.' };
        const cart = await shop.run((client) => cartView(client)());
        return { signedIn: true, productCount: cart.productCount, toPay: cart.toPay, deliveryWindow: cart.deliveryWindow };
      }),
  );

  const credentials = hasCredentials(config);
  server.registerTool(
    'login',
    {
      title: credentials ? 'Log in (stored credentials)' : 'Log in (opens a browser window)',
      description: credentials
        ? 'Logs in to Shufersal with the username/password the owner configured on this server (no browser; you never see them). ' +
          'Normally not needed - expired sessions are renewed automatically. Use it after a "login was rejected" error once the owner has fixed the credentials.'
        : 'Opens Chrome on the computer running this server so the USER can log in to Shufersal themselves. ' +
          `Waits up to ${Math.round(config.loginTimeoutMs / 1000)}s, then saves the session so later calls need no browser. ` +
          'Only works where a window can be shown (not on a headless server). Tell the user a window will open first. You never see or enter credentials.',
      annotations: { openWorldHint: true },
    },
    () =>
      respond(async () => {
        await shop.signIn();
        return { signedIn: true };
      }),
  );

  server.registerTool(
    'search_products',
    {
      title: 'Search products',
      description: 'Search the Shufersal catalog (Hebrew works best). Returns P_ codes, names, brands, prices and stock.',
      inputSchema: { query: z.string().min(1), limit: z.number().int().min(1).max(20).default(10) },
      annotations: { readOnlyHint: true },
    },
    ({ query, limit }) =>
      respond(() =>
        shop.run(async (client) =>
          (await client.search(query.replace(/:/g, ' '), limit)).map((c) => ({
            code: c.code,
            name: c.name,
            brand: c.brand,
            unit: c.unitDescription,
            price: c.priceText,
            inStock: c.inStock,
            sellingMethod: c.sellingMethod,
          })),
        ),
      ),
  );

  server.registerTool(
    'view_cart',
    {
      title: 'View cart',
      description: "Every product in the cart with quantity and line price, Shufersal's own total to pay and savings, and the chosen delivery window.",
      annotations: { readOnlyHint: true },
    },
    () => respond(() => shop.run((client) => cartView(client)())),
  );

  server.registerTool(
    'add_to_cart',
    {
      title: 'Add products by code',
      description:
        'Add specific products (P_ codes, e.g. from search_products or an ambiguous line\'s candidates) in one request. ' +
        'Products already in the cart are left as they are. When the user picked the product for a list line, set remember_as ' +
        'to that line so it resolves to this product automatically next time.',
      inputSchema: {
        items: z
          .array(
            z.object({
              code: productCode,
              quantity: quantity.default(1),
              remember_as: z.string().min(1).optional().describe('The list line the user chose this product for, e.g. "חלב 3%"'),
            }),
          )
          .min(1)
          .max(100),
        dry_run: dryRun,
      },
    },
    ({ items, dry_run }) =>
      respond(() =>
        shop.run(async (client, session) => {
          const list: ListItem[] = items.map((it, i) => ({ line: i + 1, raw: it.code, query: '', productCode: it.code, quantity: it.quantity }));
          const result = fillJson(await fill(client, session, list, dry_run), list.length);
          const remembered = [];
          if (!dry_run) for (const it of items) if (it.remember_as) remembered.push(await remember(client, it.remember_as, it.code));
          return remembered.length ? { ...result, remembered } : result;
        }),
      ),
  );

  server.registerTool(
    'remember_choice',
    {
      title: 'Remember a product choice',
      description:
        'Remember that a list line means a specific product (e.g. "חלב 3%" -> P_4131074). Next time that line appears, it is looked up ' +
        'exactly by the product\'s מקט instead of searched. Lines match regardless of word order; "3 אחוז" counts as "3%".',
      inputSchema: { line: z.string().min(1), code: productCode },
    },
    ({ line, code }) => respond(() => shop.run((client) => remember(client, line, code))),
  );

  server.registerTool(
    'list_choices',
    {
      title: 'Remembered product choices',
      description: 'All remembered "this line means this product" choices.',
      annotations: { readOnlyHint: true },
    },
    () => respond(async () => choices().all()),
  );

  server.registerTool(
    'forget_choice',
    {
      title: 'Forget a product choice',
      description: 'Forget the remembered product for a list line, so it is searched again next time.',
      inputSchema: { line: z.string().min(1) },
      annotations: { idempotentHint: true },
    },
    ({ line }) => respond(async () => ({ forgotten: choices().remove(line) })),
  );

  server.registerTool(
    'fill_cart_from_list',
    {
      title: 'Fill cart from a shopping list',
      description:
        'Add a shopping list, one item per line: "חלב 3% x2", "2 x במבה", or a pinned code "P_4131074 x2". ' +
        'Each line is added only if exactly one in-stock product matches; ambiguous lines come back with candidates for the user to choose from.',
      inputSchema: { list: z.string().min(1).describe('One item per line. Lines starting with # are ignored.'), dry_run: dryRun },
    },
    ({ list, dry_run }) =>
      respond(() =>
        shop.run(async (client, session) => {
          const parsed = parseList(list);
          if (parsed.items.length === 0) throw new SessionError('The list has no items.');
          return fillJson(await fill(client, session, parsed.items, dry_run), parsed.items.length, {
            skippedLines: parsed.errors.map((e) => ({ line: e.line, input: e.raw, reason: e.reason })),
          });
        }),
      ),
  );

  server.registerTool(
    'set_quantity',
    {
      title: 'Change a quantity',
      description: 'Set the quantity of a product already in the cart (0 removes it). Only per-unit products; weighed items are changed in the app.',
      inputSchema: { code: productCode, quantity: z.number().int().min(0).max(MAX_QUANTITY) },
      annotations: { destructiveHint: true, idempotentHint: true },
    },
    ({ code, quantity: qty }) =>
      respond(() =>
        shop.run(async (client) => {
          await client.setQuantity(code, qty);
          return cartView(client)();
        }),
      ),
  );

  server.registerTool(
    'remove_from_cart',
    {
      title: 'Remove a product',
      description: 'Remove a product from the cart.',
      inputSchema: { code: productCode },
      annotations: { destructiveHint: true, idempotentHint: true },
    },
    ({ code }) =>
      respond(() =>
        shop.run(async (client) => {
          await client.setQuantity(code, 0);
          return cartView(client)();
        }),
      ),
  );

  server.registerTool(
    'list_orders',
    {
      title: 'Past orders',
      description: 'The account\'s past orders, newest first: code, date, total, item count.',
      inputSchema: { limit: z.number().int().min(1).max(100).default(10) },
      annotations: { readOnlyHint: true },
    },
    ({ limit }) => respond(() => shop.run(async (client) => (await client.orders()).slice(0, limit))),
  );

  const findOrder = async (client: ShufersalClient, order: string) => {
    const orders = await client.orders();
    const found = order === 'latest' ? orders[0] : orders.find((o) => o.code === order);
    if (!found) throw new SessionError(order === 'latest' ? 'No past orders.' : `No order ${order}. Use list_orders.`);
    return found;
  };
  const orderArg = z.string().min(1).describe('"latest" or an order code from list_orders');

  server.registerTool(
    'get_order',
    {
      title: 'Items of a past order',
      description: 'The products in a past order (delivery fees excluded), marked addable or not.',
      inputSchema: { order: orderArg },
      annotations: { readOnlyHint: true },
    },
    ({ order }) =>
      respond(() =>
        shop.run(async (client) => {
          const found = await findOrder(client, order);
          const items = await client.orderItems(found.code);
          const { skipped } = itemsToList(items);
          const skippedCodes = new Set(skipped.map((s) => s.code));
          return { order: found, items: items.map((i) => ({ ...i, addable: !skippedCodes.has(i.code) })) };
        }),
      ),
  );

  server.registerTool(
    'add_order_to_cart',
    {
      title: 'Reorder a past order',
      description: 'Add the products of a past order to the cart (like the site\'s "add all"). Use dry_run first and confirm with the user.',
      inputSchema: { order: orderArg, dry_run: dryRun },
    },
    ({ order, dry_run }) =>
      respond(() =>
        shop.run(async (client, session) => {
          const found = await findOrder(client, order);
          const { list, skipped } = itemsToList(await client.orderItems(found.code));
          return fillJson(await fill(client, session, list, dry_run), list.length, { source: { order: found }, notAdded: skipped });
        }),
      ),
  );

  const findList = async (client: ShufersalClient, list: string) => {
    const lists = await client.savedLists();
    const found = lists.find((l) => l.id === list) ?? lists.find((l) => l.name.trim() === list.trim());
    if (!found) throw new SessionError(`No saved list "${list}". Use list_saved_lists.`);
    return found;
  };
  const listArg = z.string().min(1).describe('Saved list name or id from list_saved_lists');

  server.registerTool(
    'list_saved_lists',
    {
      title: 'Saved shopping lists',
      description: "The user's saved Shufersal shopping lists: id, name, item count.",
      annotations: { readOnlyHint: true },
    },
    () => respond(() => shop.run((client) => client.savedLists())),
  );

  server.registerTool(
    'get_saved_list',
    {
      title: 'Items of a saved list',
      description: 'The products in a saved shopping list, marked addable or not.',
      inputSchema: { list: listArg },
      annotations: { readOnlyHint: true },
    },
    ({ list }) =>
      respond(() =>
        shop.run(async (client) => {
          const found = await findList(client, list);
          const items = await client.savedListItems(found.id);
          const skippedCodes = new Set(itemsToList(items).skipped.map((s) => s.code));
          return { list: found, items: items.map((i) => ({ ...i, addable: !skippedCodes.has(i.code) })) };
        }),
      ),
  );

  server.registerTool(
    'add_saved_list_to_cart',
    {
      title: 'Add a saved list to the cart',
      description: 'Add the products of a saved shopping list to the cart. Use dry_run first and confirm with the user.',
      inputSchema: { list: listArg, dry_run: dryRun },
    },
    ({ list, dry_run }) =>
      respond(() =>
        shop.run(async (client, session) => {
          const found = await findList(client, list);
          const { list: items, skipped } = itemsToList(await client.savedListItems(found.id));
          return fillJson(await fill(client, session, items, dry_run), items.length, { source: { savedList: found }, notAdded: skipped });
        }),
      ),
  );

  server.registerTool(
    'list_delivery_slots',
    {
      title: 'Delivery windows',
      description: 'Available home-delivery windows for the default address (Israel time) and the one currently chosen.',
      annotations: { readOnlyHint: true },
    },
    () =>
      respond(() =>
        shop.run(async (client) => {
          const [slots, current] = [await client.deliverySlots(), await client.selectedSlot()];
          return {
            current: current ? `${current.start}-${current.endTime}` : null,
            slots: slots.map((s) => ({ start: s.start, end: s.endTime, available: s.selectable, price: s.priceText })),
          };
        }),
      ),
  );

  server.registerTool(
    'choose_delivery_slot',
    {
      title: 'Choose a delivery window',
      description: 'Pre-select the delivery window that starts at the given time (from list_delivery_slots). Nothing is ordered. Only choose a window the user asked for.',
      inputSchema: { start: z.string().describe('Window start, "YYYY-MM-DD HH:MM" Israel time') },
    },
    ({ start }) =>
      respond(() =>
        shop.run(async (client) => {
          const wanted = normalizeStart(start);
          if (!wanted) throw new SessionError('start must look like "2026-11-02 18:00".');
          const slot = (await client.deliverySlots()).find((s) => s.start === wanted);
          if (!slot) throw new SessionError(`No delivery window starts at ${wanted}. Use list_delivery_slots.`);
          if (!slot.selectable) throw new SessionError(`${wanted} is full or closed.`);
          if ((await client.selectedSlot())?.code !== slot.code) {
            const accepted = await client.selectSlot(slot);
            const after = await client.selectedSlot();
            if (!accepted || after?.code !== slot.code) throw new SessionError('The site did not confirm the delivery window.');
          }
          return { chosen: `${slot.start}-${slot.endTime}`, price: slot.priceText, reminder: 'Nothing was ordered. The user checks out and pays in the Shufersal app or site.' };
        }),
      ),
  );

  return server;
}

export async function main(): Promise<void> {
  // stdout is the protocol channel: anything printed there would corrupt it.
  console.log = (...args: unknown[]) => console.error(...args);
  loadDotEnv();
  // This server only ever talks HTTP; a browser is used solely by the `login` tool.
  const config: ShoppingConfig = { ...loadConfig(), transport: 'http' };
  const shop = new Shop(config, (m) => console.error(`[shufersal] ${m}`));
  await createServer(shop).connect(new StdioServerTransport());
  console.error('[shufersal] MCP server ready (stdio).');
}

export { Shop };
