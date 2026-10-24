import { loadConfig, loadDotEnv } from '../config.js';
import { ShufersalClient } from '../shufersal/client.js';
import { connect } from '../shufersal/connect.js';
import { SessionError, type Transport } from '../shufersal/transport.js';
import type { CartLine } from '../shufersal/types.js';

const USAGE = `
Usage:
  npm run cart                         Show the cart and the site's own total
  npm run cart -- --set P_4131074 3    Change a product's quantity
  npm run cart -- --remove P_4131074   Remove a product

Adding items: npm run cart:fill -- <list>. Paying: in the Shufersal app or
site - this tool never checks out.
`.trimStart();

async function main(): Promise<number> {
  loadDotEnv();
  const args = process.argv.slice(2);
  if (args.includes('-h') || args.includes('--help')) {
    process.stdout.write(USAGE);
    return 0;
  }
  const setAt = args.indexOf('--set');
  const removeAt = args.indexOf('--remove');
  let change: { code: string; qty: number } | null = null;
  if (setAt !== -1) {
    const code = args[setAt + 1]?.toUpperCase();
    const qty = Number(args[setAt + 2]);
    if (!code || !/^P_\d+$/.test(code) || !Number.isInteger(qty)) return usageError('--set needs a product code and a whole number, e.g. --set P_4131074 3');
    change = { code, qty };
  } else if (removeAt !== -1) {
    const code = args[removeAt + 1]?.toUpperCase();
    if (!code || !/^P_\d+$/.test(code)) return usageError('--remove needs a product code, e.g. --remove P_4131074');
    change = { code, qty: 0 };
  }

  let session: Transport | null = null;
  try {
    session = await connect(loadConfig(), (m) => console.log(`  ${m}`));
    const client = new ShufersalClient(session);
    console.log('');

    let lines: CartLine[];
    if (change) {
      const before = (await client.cartLines()).find((l) => l.code === change.code);
      lines = await client.setQuantity(change.code, change.qty);
      const name = before?.name ?? change.code;
      console.log(change.qty === 0 ? `Removed: ${name}` : `${name}: ${before?.quantity ?? '?'} -> ${change.qty}`);
      console.log('');
    } else {
      lines = await client.cartLines();
    }

    printCart(lines);
    const summary = await client.cartSummary();
    console.log('');
    console.log(`To pay (Shufersal's own figure): ${money(summary.toPay)}${summary.savings ? `   savings ${money(summary.savings)}` : ''}`);
    console.log('Nothing is ordered here. Pay in the Shufersal app or site when the cart looks right.');
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

function printCart(lines: CartLine[]): void {
  if (lines.length === 0) {
    console.log('The cart is empty.');
    return;
  }
  console.log(`Cart (${lines.length} products):`);
  for (const l of [...lines].sort((a, b) => a.name.localeCompare(b.name, 'he'))) {
    const qty = l.sellingMethod === 'BY_UNIT' ? `x${l.quantity}` : `${l.quantity} (${(l.sellingMethod ?? '').toLowerCase().replace('by_', 'by ')})`;
    console.log(`  ${money(l.lineTotal).padStart(10)}  ${qty.padEnd(6)} ${l.name}  [${l.code}]`);
  }
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
