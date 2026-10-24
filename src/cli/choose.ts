import { loadConfig, loadDotEnv } from '../config.js';
import { Choices, choiceKey } from '../list/choices.js';
import { ShufersalClient } from '../shufersal/client.js';
import { connect } from '../shufersal/connect.js';
import { SessionError, type Transport } from '../shufersal/transport.js';
import { skuOf } from '../shufersal/types.js';

const USAGE = `
Usage:
  npm run choose -- "חלב 3%" P_4131074     Remember: this line means this product
  npm run choose -- "חלב 3%" 4131074       (a P_ code or a מקט both work)
  npm run choose -- --list                  Show remembered choices
  npm run choose -- --forget "חלב 3%"       Forget one

Next time the line appears in a list, it is looked up by מקט - exactly, with
live price and stock - instead of being searched. Lines match regardless of
word order, and "3 אחוז" counts as "3%".
`.trimStart();

async function main(): Promise<number> {
  loadDotEnv();
  const args = process.argv.slice(2);
  const config = loadConfig();
  const choices = Choices.load(config.choicesFile);

  if (args.length === 0 || args.includes('-h') || args.includes('--help')) {
    process.stdout.write(USAGE);
    return args.length === 0 ? 2 : 0;
  }

  if (args[0] === '--list') {
    const all = choices.all();
    if (all.length === 0) console.log('No remembered choices yet.');
    for (const c of all) console.log(`  ${c.query.padEnd(24)} -> ${c.name}  [${c.code}]`);
    return 0;
  }

  if (args[0] === '--forget') {
    const line = args[1];
    if (!line) return usage('--forget needs the line, e.g. --forget "חלב 3%"');
    console.log(choices.remove(line) ? `Forgot "${line}".` : `Nothing remembered for "${line}".`);
    return 0;
  }

  const [line, product] = args;
  if (!line || !product) return usage('Give the list line and the product, e.g. "חלב 3%" P_4131074');
  if (!choiceKey(line)) return usage('The line has no words to match on.');
  const sku = /^\d{4,14}$/.test(product) ? product : skuOf(product);
  if (!sku) return usage(`Not a product code or מקט: ${product}`);

  let session: Transport | null = null;
  try {
    session = await connect(config, (m) => console.log(`  ${m}`));
    const found = await new ShufersalClient(session).findBySku(sku);
    if (!found) {
      console.error(`No product with מקט ${sku}.`);
      return 1;
    }
    const previous = choices.get(line);
    choices.set(line, { code: found.code, sku, name: found.name });
    console.log(`Remembered: "${line}" -> ${found.name} (${found.brand ?? ''}, ${found.priceText ?? '?'})  [${found.code}]`);
    if (previous && previous.code !== found.code) console.log(`  (replaces ${previous.name} [${previous.code}])`);
    if (!found.inStock) console.log('  Note: it is out of stock right now; it will be reported, not added, until it is back.');
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

function usage(message: string): number {
  console.error(message);
  process.stdout.write('\n' + USAGE);
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
