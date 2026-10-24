import path from 'node:path';
import os from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';

import type { ShoppingConfig } from '../src/config.js';
import { createServer, Shop } from '../src/mcp/server.js';

// No saved session -> every call is answered locally; nothing reaches the site.
const config: ShoppingConfig = {
  browserChannel: 'chrome',
  userDataDir: path.join(os.tmpdir(), 'shufersal-test-profile'),
  transport: 'http',
  cookieFile: path.join(os.tmpdir(), 'shufersal-test-no-such-cookies.json'),
  choicesFile: path.join(os.tmpdir(), 'shufersal-test-choices.json'),
  headless: true,
  loginTimeoutMs: 1000,
  requestDelayMs: 0,
};

async function connected() {
  const server = createServer(new Shop(config, () => {}));
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

const text = (r: unknown) => ((r as { content?: Array<{ text: string }> }).content ?? []).map((c) => c.text).join('\n');

describe('MCP server', () => {
  it('exposes the cart tools and nothing that checks out or pays', async () => {
    const client = await connected();
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining(['status', 'login', 'search_products', 'view_cart', 'add_to_cart', 'fill_cart_from_list', 'set_quantity', 'remove_from_cart', 'add_order_to_cart', 'add_saved_list_to_cart', 'list_delivery_slots', 'choose_delivery_slot']),
    );
    expect(names.filter((n) => /checkout|pay|order_now|place/i.test(n))).toEqual([]);
    expect(client.getInstructions()).toMatch(/NEVER check out or pay/);
  });

  it('reports a signed-out state without opening a browser', async () => {
    const client = await connected();
    expect(JSON.parse(text(await client.callTool({ name: 'status', arguments: {} })))).toMatchObject({ signedIn: false });

    const r = await client.callTool({ name: 'view_cart', arguments: {} });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/Not signed in.*`login` tool/s);
    // Without stored credentials, the server must not try to log in by itself.
    expect(text(r)).toMatch(/no SHUFERSAL_USERNAME/);
  });

  it('rejects malformed input before anything is sent', async () => {
    const client = await connected();
    const bad = await client.callTool({ name: 'set_quantity', arguments: { code: 'milk', quantity: 2 } });
    expect(bad.isError).toBe(true);
    const tooMany = await client.callTool({ name: 'add_to_cart', arguments: { items: [{ code: 'P_1', quantity: 500 }] } });
    expect(tooMany.isError).toBe(true);
  });
});
