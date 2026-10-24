# shufersal-cart

Build and edit your **Shufersal online cart** from a shopping list, a past
order or a saved list — from the command line or from an AI assistant over
MCP (Claude, Codex, Cursor, …).

It searches, adds, changes and removes products, shows the cart with
Shufersal's own total, and picks a delivery window.
**It never checks out or pays.** You review the ready cart and pay in the
Shufersal app or website yourself.

> Unofficial. Not affiliated with Shufersal. It uses the website's own
> internal endpoints (reverse-engineered from browser recordings), which can
> change without notice. Use it for your own account only.

## What it can do

| | Command | MCP tool |
|---|---|---|
| Log in (stored password, or a browser window) | `npm run login` | `login` |
| Search products | — | `search_products` |
| Fill the cart from a text list | `npm run cart:fill -- list.txt` | `fill_cart_from_list` |
| Add exact products by code | (pin `P_` codes in a list) | `add_to_cart` |
| Start from a past order / saved list | `npm run history` | `add_order_to_cart`, `add_saved_list_to_cart` |
| See the cart, line prices, total to pay | `npm run cart` | `view_cart` |
| Change quantity / remove | `npm run cart -- --set P_x 3` / `--remove P_x` | `set_quantity`, `remove_from_cart` |
| Delivery windows | `npm run slot` / `-- --pick "…"` | `list_delivery_slots`, `choose_delivery_slot` |
| Move a login to another machine | `npm run session -- export/import` | — |

Safety built in, not left to the caller:

- **No checkout or payment code exists** in the project.
- **Ambiguous items are never guessed.** "חלב 3%" with several sizes comes back
  as a list of candidates for you to choose from; only a line that matches
  exactly one in-stock product is added automatically.
- **Re-running never doubles the cart:** products already in it are left alone.
- **Every change is verified** against the cart the site returns.
- **Items sold by weight** are reported, not added (their quantity semantics
  were never captured, so they are not automated).
- **A refused request (403/429/challenge) stops the run.** It is never
  retried, and neither is a failed login.

## Quick start

Requires Node.js 22.5+.

```bash
git clone <this repo> shufersal-cart && cd shufersal-cart
npm install
cp .env.example .env          # optional settings, see below
npm run login                 # once: see "Logging in"
npm run cart                  # see your cart and total
```

Fill a cart from a list (`--dry-run` first to see what would happen):

```bash
npm run cart:fill -- lists/example.txt --dry-run
npm run cart:fill -- lists/example.txt
```

Or start from what you ordered last time:

```bash
npm run history                          # recent orders + saved lists
npm run history -- --order latest        # writes lists/order-<code>.txt - edit it, then cart:fill it
npm run history -- --list "<list name>"
```

Then:

```bash
npm run cart -- --set P_4131074 3        # change a quantity (0 removes)
npm run slot                             # list delivery windows
npm run slot -- --pick "2026-11-02 18:00"
```

…and pay in the Shufersal app or site.

## Logging in

Everything after a login runs as **plain HTTP with the saved session** —
no browser. The session (`sessions/shufersal-cookies.json`) stayed valid
through hours of repeated use when tested; how long it lasts beyond that has
not been measured yet (the login sends `remember-me=True`, which suggests
long-lived). When it expires, you log in again once.
There are three ways to get a session:

| Option | How | Where it works |
|---|---|---|
| **A. Stored username/password** | Put `SHUFERSAL_USERNAME` and `SHUFERSAL_PASSWORD` in `.env` (or your server's secret store). Logins — including automatic renewal when the session expires — then happen over HTTP with no browser. | Anywhere, including a headless server |
| **B. Browser login** | `npm run login -- --browser` opens Chrome; you log in yourself. | A machine with a desktop and Chrome |
| **C. Import a session** | Log in on your PC (B), `npm run session -- export s.json`, copy it to the server, `npm run session -- import s.json`. | Anywhere; nothing secret stored on the server except the session itself |

Notes:

- Option A uses the site's own login form, field for field
  (`docs/SHUFERSAL-API.md`). The recorded login (2026-10) needed **no captcha
  and no SMS code**. If Shufersal ever asks for one, the login fails cleanly,
  is **not retried** (to avoid locking the account), and you fall back to B or C.
- The password is only sent to that login form. It is never logged or written
  to disk by the tool. If it is in `.env`, `.env` itself is plaintext on disk;
  on a server, prefer the platform's secret store.
- An AI assistant using the MCP server **never sees the password**; it only
  calls tools.
- The session file is a logged-in key to the account until it expires.
  It is gitignored; move it only over encrypted channels.

## Use from an AI assistant (MCP)

```bash
claude mcp add shufersal -- node <path-to-repo>/bin/shufersal-mcp.mjs     # Claude Code
```

Claude Desktop / Cursor (`mcpServers` in the client's config):
```json
{ "mcpServers": { "shufersal": { "command": "node", "args": ["<path-to-repo>/bin/shufersal-mcp.mjs"] } } }
```

Codex (`~/.codex/config.toml`):
```toml
[mcp_servers.shufersal]
command = "node"
args = ["<path-to-repo>/bin/shufersal-mcp.mjs"]
```

Then ask, e.g.: *"Start my Shufersal cart from last week's order, swap the
milk for Tnuva 3%, add two bamba, show me the total and pick Monday evening."*

The server sends the assistant its rules (never guess ambiguous items, dry-run
whole orders first, only choose a delivery window you asked for, the user pays
in the app). It never opens a browser on its own; only the explicit `login`
tool does, and only when no credentials are configured.

The server speaks MCP over **stdio**, so the assistant must run on the same
machine. Using it from a phone or a cloud assistant needs a remote transport —
see `docs/DEPLOYMENT.md`.

## List format

```
# comments and blank lines are ignored
חלב 3% x2            quantity via x2 / ×2 / *2, or a leading "2 x"
ביצים L 12           a bare number stays part of the product name
P_7290000042011 x3   exact product code: no search, no guessing
P_4131074   # note   text after " #" is a note (shown in output)
```

Once you have chosen a product from the candidates, pin its `P_` code in your
list — that makes recurring items fully automatic.

## Configuration (`.env`)

| Variable | Default | Meaning |
|---|---|---|
| `SHUFERSAL_USERNAME`, `SHUFERSAL_PASSWORD` | — | Login option A. Set by the account owner only. |
| `SHUFERSAL_TRANSPORT` | `http` | `browser` runs every request inside Chrome instead (fallback if plain HTTP is ever refused) |
| `SHUFERSAL_COOKIE_FILE` | `sessions/shufersal-cookies.json` | Saved session |
| `SHUFERSAL_BROWSER_CHANNEL` | `chrome` | Browser for login B: `chrome` or `msedge` |
| `SHUFERSAL_HEADLESS` | `1` | Browser login starts hidden and shows a window only if a login is needed |
| `SHUFERSAL_USER_DATA_DIR` | `sessions/shufersal` | Browser profile for login B |
| `SHUFERSAL_LOGIN_TIMEOUT_SECONDS` | `300` | How long a browser login waits for you |
| `SHUFERSAL_REQUEST_DELAY_MS` | `1200` | Pause between searches — a person shopping, not a crawler |

## Documentation

- [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) — running it on a server, login options there, remote/mobile use
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — how the code is organised and why
- [`docs/SHUFERSAL-API.md`](docs/SHUFERSAL-API.md) — every endpoint used, with request/response contracts
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — development, tests, capturing new endpoints safely

## Status

Tested against a real account (2026-10): search, list fill, bulk add, cart
view/edit/remove, totals, order history, saved lists, delivery windows,
browser login, session export/import, and the MCP server end to end.
The password login is implemented exactly to a recorded real login and
covered by tests against a fake site, but should be confirmed once with real
credentials (`npm run login -- --password`).

## License

MIT — see [LICENSE](LICENSE).
