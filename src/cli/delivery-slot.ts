import { loadConfig, loadDotEnv } from '../config.js';
import { ShufersalClient } from '../shufersal/client.js';
import { connect } from '../shufersal/connect.js';
import { SessionError, type Transport } from '../shufersal/transport.js';
import { normalizeStart, type Slot } from '../shufersal/types.js';

const USAGE = `
Usage: npm run slot -- [--pick "YYYY-MM-DD HH:MM"]

  (no option)                 List the delivery windows and the one currently chosen.
  --pick "2026-11-02 14:00"   Choose the window that starts then (Israel time).

Choosing a window only pre-selects it for the cart. Nothing is ordered or paid.
There is no "earliest" or automatic pick: you name the exact window.
`.trimStart();

async function main(): Promise<number> {
  loadDotEnv();
  const args = process.argv.slice(2);
  if (args.includes('-h') || args.includes('--help')) {
    process.stdout.write(USAGE);
    return 0;
  }
  const pickIndex = args.indexOf('--pick');
  const wanted = pickIndex === -1 ? null : normalizeStart(args[pickIndex + 1] ?? '');
  if (pickIndex !== -1 && !wanted) {
    console.error('--pick needs a start time like "2026-11-02 14:00"');
    return 2;
  }

  let session: Transport | null = null;

  try {
    session = await connect(loadConfig(), (m) => console.log(`  ${m}`));
    const client = new ShufersalClient(session);

    const slots = await client.deliverySlots();
    const current = await client.selectedSlot();
    console.log('');

    if (!wanted) {
      printSlots(slots, current);
      console.log('');
      console.log(`Currently chosen: ${current ? describe(current) : 'none'}`);
      return 0;
    }

    const slot = slots.find((s) => s.start === wanted);
    if (!slot) {
      console.error(`No delivery window starts at ${wanted}. Run without --pick to see the list.`);
      return 1;
    }
    if (!slot.selectable) {
      console.error(`${describe(slot)} is not available (full or closed).`);
      return 1;
    }
    if (current?.code === slot.code) {
      console.log(`Already chosen: ${describe(slot)}`);
      return 0;
    }

    const accepted = await client.selectSlot(slot);
    const after = await client.selectedSlot();
    if (!accepted || after?.code !== slot.code) {
      console.error(`The site did not confirm the window (answered ${accepted}, now chosen: ${after ? describe(after) : 'none'}).`);
      return 1;
    }
    console.log(`Chosen: ${describe(slot)}`);
    console.log('Nothing was ordered. Review the cart and check out yourself in the Shufersal app or site.');
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

function describe(s: Slot): string {
  return `${s.start}-${s.endTime}${s.priceText ? ` · ${s.priceText}` : ''}`;
}

function printSlots(slots: Slot[], current: Slot | null): void {
  if (slots.length === 0) {
    console.log('No delivery windows offered.');
    return;
  }
  let day = '';
  for (const s of slots) {
    const date = s.start.slice(0, 10);
    if (date !== day) {
      day = date;
      const weekday = new Date(`${date}T12:00:00Z`).toLocaleDateString('he-IL', { weekday: 'long', timeZone: 'Asia/Jerusalem' });
      console.log(`${date} (${weekday})`);
    }
    const mark = current?.code === s.code ? '●' : s.selectable ? ' ' : '✗';
    console.log(`  ${mark} ${s.start.slice(11)}-${s.endTime}${s.priceText ? `  ${s.priceText}` : ''}${s.selectable ? '' : '  (full)'}`);
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
