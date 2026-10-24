import fs from 'node:fs';
import path from 'node:path';

import { loadConfig, loadDotEnv } from '../config.js';
import { ShufersalClient } from '../shufersal/client.js';
import { connect } from '../shufersal/connect.js';
import { SessionError, type Transport } from '../shufersal/transport.js';
import { toListFile, type SourceItem } from '../shufersal/types.js';

const USAGE = `
Usage:
  npm run history                                 Recent orders and your saved lists
  npm run history -- --order latest               Start a list from your last order
  npm run history -- --order 01234567             ...or from a specific order
  npm run history -- --list "לחג"                 ...or from a saved list (name or id)

  --out <file>   Where to write the list (default: lists/order-<code>.txt / lists/saved-<id>.txt)
  --force        Overwrite that file if it exists
  --all          Show all orders, not just the last 10

Read-only on the site: this only writes a local list file. Edit it, then run
  npm run cart:fill -- <file>
`.trimStart();

function arg(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
}

async function main(): Promise<number> {
  loadDotEnv();
  const args = process.argv.slice(2);
  if (args.includes('-h') || args.includes('--help')) {
    process.stdout.write(USAGE);
    return 0;
  }
  const orderArg = arg(args, '--order');
  const listArg = arg(args, '--list');
  if (args.includes('--order') && !orderArg) return usageError('--order needs "latest" or an order code');
  if (args.includes('--list') && !listArg) return usageError('--list needs a list name or id');

  let session: Transport | null = null;
  try {
    session = await connect(loadConfig(), (m) => console.log(`  ${m}`));
    const client = new ShufersalClient(session);
    console.log('');

    if (orderArg) {
      const orders = await client.orders();
      const order = orderArg === 'latest' ? orders[0] : orders.find((o) => o.code === orderArg);
      if (!order) return usageError(orderArg === 'latest' ? 'No past orders found.' : `No order ${orderArg}. Run without options to see them.`);
      const items = await client.orderItems(order.code);
      return write(args, `lists/order-${order.code}.txt`, `From order ${order.code} (${order.created}, ${money(order.total)})`, items);
    }

    if (listArg) {
      const lists = await client.savedLists();
      const list = lists.find((l) => l.id === listArg) ?? lists.find((l) => l.name.trim() === listArg.trim());
      if (!list) return usageError(`No saved list "${listArg}". Run without options to see them.`);
      const items = await client.savedListItems(list.id);
      return write(args, `lists/saved-${list.id}.txt`, `From saved list "${list.name}"`, items);
    }

    const orders = await client.orders();
    const shown = args.includes('--all') ? orders : orders.slice(0, 10);
    console.log(`Past orders (${orders.length})${shown.length < orders.length ? ` - latest ${shown.length}, --all for the rest` : ''}:`);
    for (const o of shown) console.log(`  ${o.code}  ${o.created}  ${money(o.total).padStart(11)}  ${o.itemCount ?? '?'} items`);
    console.log('');
    const lists = await client.savedLists();
    console.log(`Saved lists (${lists.length}):`);
    for (const l of lists) console.log(`  ${l.id.padEnd(10)} ${l.name}  (${l.itemCount ?? '?'} items)`);
    console.log('');
    console.log('Start a list with --order latest, --order <code>, or --list <name or id>.');
    return 0;
  } catch (error) {
    if (error instanceof SessionError) {
      console.error(error.message);
      return 1;
    }
    throw error;
  } finally {
    await session?.close();
  }
}

function write(args: string[], fallback: string, title: string, items: SourceItem[]): number {
  if (items.length === 0) return usageError(`${title}: no items found.`);
  const file = path.resolve(process.cwd(), arg(args, '--out') ?? fallback);
  if (fs.existsSync(file) && !args.includes('--force')) {
    return usageError(`${path.relative(process.cwd(), file)} already exists - use --force to overwrite, or --out <file>.`);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, toListFile(title, items), 'utf8');

  const manual = items.filter((i) => i.sellingMethod && i.sellingMethod !== 'BY_UNIT').length;
  const outOfStock = items.filter((i) => i.outOfStock && !(i.sellingMethod && i.sellingMethod !== 'BY_UNIT')).length;
  console.log(`${title}: ${items.length} items -> ${path.relative(process.cwd(), file)}`);
  console.log(`  ${items.length - manual - outOfStock} ready to add${manual ? `, ${manual} sold by weight/package (commented out)` : ''}${outOfStock ? `, ${outOfStock} out of stock (commented out)` : ''}`);
  console.log('');
  console.log(`Edit it if you like, then:  npm run cart:fill -- ${path.relative(process.cwd(), file)} --dry-run`);
  return 0;
}

function money(v: number | null): string {
  return v === null ? '?' : `${v.toFixed(2)} ₪`;
}

function usageError(message: string): number {
  console.error(message);
  return 2;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
