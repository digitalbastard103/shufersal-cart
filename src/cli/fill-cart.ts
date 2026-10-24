import fs from 'node:fs';
import path from 'node:path';

import { describe, fillCart, summarize, type FillResult } from '../cart/fill.js';
import { loadConfig, loadDotEnv } from '../config.js';
import { parseList } from '../list/parse-list.js';
import { ShufersalClient } from '../shufersal/client.js';
import { connect } from '../shufersal/connect.js';
import { SessionError, type Transport } from '../shufersal/transport.js';

const USAGE = `
Usage: npm run cart:fill -- <list.txt> [--dry-run]

  --dry-run   Search and report only. Nothing is added to the cart.

Adds each list line it can match with certainty, in one bulk request.
Ambiguous lines are reported with candidate P_ codes, never guessed. It NEVER
checks out or pays: review and place the order yourself in the Shufersal app
or site.
`.trimStart();

async function main(): Promise<number> {
  loadDotEnv();
  const args = process.argv.slice(2);
  if (args.includes('-h') || args.includes('--help') || args.length === 0) {
    process.stdout.write(USAGE);
    return args.length === 0 ? 2 : 0;
  }
  const dryRun = args.includes('--dry-run');
  const listFile = args.find((a) => !a.startsWith('--'));
  if (!listFile || !fs.existsSync(listFile)) {
    console.error(`List file not found: ${listFile ?? '(none)'}`);
    return 2;
  }

  const { items, errors } = parseList(fs.readFileSync(listFile, 'utf8'));
  for (const e of errors) console.log(`  line ${e.line} skipped (${e.reason}): ${e.raw}`);
  if (items.length === 0) {
    console.error('Nothing to do - the list has no items.');
    return 2;
  }

  const config = loadConfig();
  console.log(`${items.length} item(s) from ${listFile}${dryRun ? ' - DRY RUN, nothing will be added' : ''}`);
  console.log('');

  let session: Transport | null = null;
  let result: FillResult;
  try {
    session = await connect(config, (m) => console.log(`  ${m}`));
    const transport = session;
    const client = new ShufersalClient(transport);
    console.log('');
    result = await fillCart(client, items, {
      dryRun,
      delayMs: config.requestDelayMs,
      pause: (ms) => transport.pause(ms),
      onOutcome: (o) => console.log(describe(o)),
      onBulkAdd: (n) => console.log(`\nAdding ${n} product(s) in one request…`),
    });
  } catch (error) {
    if (!(error instanceof SessionError)) throw error;
    result = { dryRun, outcomes: [], stoppedEarly: error.message };
  } finally {
    await session?.close();
  }

  console.log('');
  console.log(summarize(result, items.length));
  if (!dryRun && result.outcomes.some((o) => o.status === 'added')) {
    console.log('Nothing was ordered. Review the cart and check out yourself in the Shufersal app or site.');
  }
  const file = writeResults(listFile, result);
  console.log(`Details: ${path.relative(process.cwd(), file)}`);
  return result.stoppedEarly ? 1 : 0;
}

function writeResults(listFile: string, result: FillResult): string {
  const dir = path.resolve(process.cwd(), 'out');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(dir, `cart-${stamp}.json`);
  fs.writeFileSync(file, JSON.stringify({ listFile, ...result }, null, 2), 'utf8');
  return file;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
