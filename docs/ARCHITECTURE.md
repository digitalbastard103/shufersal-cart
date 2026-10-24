# Architecture

## Layout

```
bin/shufersal-mcp.mjs     MCP launcher: chdir to the repo, load TS via tsx, start the server
src/
  config.ts               .env loader + typed config (all SHUFERSAL_* variables)
  list/
    parse-list.ts         text list -> ListItem[]   (quantities, pinned P_ codes, notes)
    match.ts              search results -> one confident pick | ambiguous | none
    choices.ts            remembered "this line means this product" (by מקט)
  cart/
    fill.ts               ListItem[] -> cart: resolve each line, one bulk add, verify
  shufersal/
    types.ts              endpoint table, response types, all HTML/JSON parsers (pure)
    transport.ts          Transport interface, errors, block detection, signed-in probe
    http-session.ts       Transport over Node fetch + cookie jar; password login
    session.ts            Transport inside a real Chrome page (Playwright); browser login
    cookies.ts            minimal RFC 6265 cookie jar, saved as JSON
    connect.ts            "give me a signed-in transport": saved -> password -> browser
    client.ts             ShufersalClient: the site operations, typed
  cli/                    one file per npm script
  mcp/server.ts           MCP tools over the same client
test/                     vitest; offline (fakes), no account needed
docs/                     this file, DEPLOYMENT.md, SHUFERSAL-API.md
```

## Layers

```
 CLI (src/cli/*)            MCP server (src/mcp/server.ts)
          \                        /
           \                      /
         cart/fill.ts   (list -> cart pipeline)
                     |
         shufersal/client.ts   (search, cart, orders, lists, slots)
                     |
         Transport  ─────────────┬────────────────────────┐
         http-session.ts (default, no browser)     session.ts (Chrome; login,
                                                   or SHUFERSAL_TRANSPORT=browser)
```

- **`types.ts` is pure:** endpoint paths, and parsers from raw site responses to
  typed values. Everything there is unit-tested against markup and JSON
  copied from real recordings. Update it first when the site changes.
- **`client.ts`** turns site operations into typed methods and enforces their
  invariants (see below). It knows nothing about cookies or browsers.
- **`Transport`** carries one request. Two implementations share the same
  refusal rules (`assertNotBlocked`) and the same CSRF handling: JSON POSTs
  carry a `csrftoken` header, form POSTs (`FormBody`) a `CSRFToken` field.
- **`connect.ts`** decides how to get signed in. The MCP server calls it with
  `allowBrowserLogin: false`, so it never opens a window on its own.

## Login and session

```
connect():
  1. saved session cookies  ── probe ok? ──> HttpSession
  2. SHUFERSAL_USERNAME/PASSWORD set, not rejected earlier ──> passwordLogin() ──> HttpSession
  3. allowBrowserLogin ──> browserLogin(): Chrome on its own profile
        hidden if that profile is still signed in, else a visible window for the user
        ──> export cookies ──> HttpSession
  else NotSignedInError
```

- "Signed in" means `GET /checkout/address/list` returns a non-empty JSON
  array (`probeSignedIn`). The addresses are never printed or kept.
- A rejected password login sets a process-wide flag: automatic logins stop,
  and only an explicit `login()` tries again. Failed logins must never loop.
- `HttpSession` follows redirects by hand so every hop's `Set-Cookie` lands in
  the jar, and saves the jar on `close()` so rotated cookies survive.
- Requests identify as Node, not Chrome; nothing is disguised.

## The cart-fill pipeline (`cart/fill.ts`)

1. Read the cart once (product code -> quantity).
2. For each list line:
   - pinned `P_` code -> that product
   - a bare number (מקט), or a line with a remembered choice
     (`list/choices.ts`, keyed by the line's sorted words) -> exact lookup by
     מקט (`client.findBySku`): only a result whose `sku` equals it counts;
     out of stock is reported, never swapped
   - otherwise search, then `match.decide`: auto-pick only if exactly one
     in-stock result contains every word of the line, or exactly one is named
     exactly that; otherwise `ambiguous` with up to 4 candidates.
   - already in the cart -> `already-in-cart` (never doubled)
   - the same product twice in one list -> `duplicate`
   - sold by weight/package -> `by-weight` (not automated)
3. One bulk add (`cart/addGrid`) for everything resolved.
4. Each product is confirmed against the cart HTML that request returns;
   anything missing is `unverified`, never reported as added.

## Invariants worth protecting

- **No checkout/payment code.** Not as a tool, not as a hidden option. The
  MCP test asserts no tool name looks like checkout/pay.
- **Cart entry numbers are never cached.** `cart/update` addresses a line by
  its entry number, and the site renumbers lines after a removal.
  `setQuantity` reads the cart immediately before every change (a test fakes
  the renumbering).
- **Totals are the site's own** (`cart/cartsummary`, "סה"כ לתשלום"), never
  computed. The mini-cart's total excludes cart-level promotions.
- **Delivery-fee lines are not products.** Past orders contain them
  (`product.deliveryItem: true`); they are dropped when reordering, like the
  site's own "add all".
- **Refusals stop the run.** 403/429 or a challenge page throws
  `BlockedError`, which is never caught-and-retried.
- **stdout is the MCP channel.** The server routes `console.log` to stderr;
  never print to stdout from code the server uses.
- **Credentials:** only `passwordLogin` reads them, they are only sent to the
  login form, and they are never logged, persisted, or passed to the assistant.

## Adding a feature

1. Record a HAR of doing it on the website (CONTRIBUTING.md).
2. Document the request/response in `docs/SHUFERSAL-API.md`.
3. Add the endpoint + parser to `types.ts`, with a test built from the
   recorded (redacted) response.
4. Add a `client.ts` method that enforces the operation's invariants.
5. Expose it in `cli/` and/or `mcp/server.ts`.
6. Verify once against a real account, read-only or reversible first.
