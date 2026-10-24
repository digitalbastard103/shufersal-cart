# Deployment

How to run shufersal-cart somewhere other than the PC it was built on: a home
server, a VPS, a Raspberry Pi. Nothing here checks out or pays — the server
only prepares the cart.

## Requirements

- Node.js 22.5+ (uses built-in `fetch` and modern ESM).
- Outbound HTTPS to `www.shufersal.co.il`. Note that some sites treat
  datacenter IP ranges differently from home connections; a home server is the
  safest bet. If requests start being refused (403/429), the tool stops — see
  "When things break".
- **No browser is needed on the server** if you log in with option A or C below.
  Chrome is only used for the interactive browser login (option B).

```bash
git clone <repo> shufersal-cart && cd shufersal-cart
npm ci
npm test            # offline; no account needed
```

## Getting a session onto the server

All runtime calls use the saved session cookies over plain HTTP. The question
is only how the first session (and renewals) get there.

### A. Stored username/password (fully unattended)

Provide `SHUFERSAL_USERNAME` and `SHUFERSAL_PASSWORD` to the process —
preferably from the platform's secret store (systemd `LoadCredential=`,
Docker/Kubernetes secrets, a `.env` readable only by the service user), not a
world-readable file.

```bash
npm run login -- --password     # one-time check that the credentials work
```

After that, when the session expires, the next call renews it automatically
with the same credentials, with no browser.

- Exactly the site's own login form is submitted (see `SHUFERSAL-API.md`).
- A rejected login is **never retried automatically** (to avoid locking the
  account). Until someone runs `npm run login` again (or the MCP `login` tool),
  calls report "not signed in".
- If Shufersal adds a captcha or an SMS step to logins, this option stops
  working by design. Use B or C. The project will not try to solve or bypass
  a captcha.

### B. Browser login on the server

Only possible if the server has a desktop session and Chrome:

```bash
npm run login -- --browser
```

On a headless server there is no window to log in through; use A or C.

### C. Log in on your PC, import the session on the server

Nothing about your password ever touches the server.

```bash
# on your PC
npm run login                                   # browser or password, whichever you use there
npm run session -- export shufersal-session.json

scp shufersal-session.json server:~/shufersal-cart/

# on the server
npm run session -- import shufersal-session.json   # verified before it is kept
rm shufersal-session.json
```

When the session eventually expires, repeat. `npm run session -- status`
tells you whether it still works (handy in a cron job that alerts you).

The session file is a logged-in key to the Shufersal account until it
expires. Move it only over encrypted channels and delete copies.

## Running the CLI on a schedule

Example: fill the cart every Thursday from a pinned weekly list, leaving
checkout to you.

```bash
# crontab -e
0 18 * * 4  cd /home/me/shufersal-cart && npm run cart:fill -- lists/weekly.txt >> out/cron.log 2>&1
```

Exit codes: `0` ok, `1` stopped (not signed in, refused, error), `2` usage.

## Running the MCP server

The MCP server (`bin/shufersal-mcp.mjs`) speaks MCP over **stdio**: the
assistant starts it as a subprocess. That works when the assistant runs on the
same machine — e.g. Claude Code or Codex on the server, used over SSH.

### Using it from a phone or a cloud assistant (not built yet)

A phone app or a cloud-hosted assistant cannot start a process on your server;
it needs a **remote** MCP endpoint. That means adding the SDK's Streamable HTTP
transport (`@modelcontextprotocol/sdk/server/streamableHttp.js`) next to the
stdio one. If you build it, treat it as security-critical — whoever can reach
it can change your cart:

- Put it behind HTTPS and real authentication (OAuth per the MCP spec, or at
  minimum a long random bearer token checked on every request).
- Bind it to localhost and expose it through a tunnel/reverse proxy you
  control; never expose it raw to the internet.
- Keep it one account per deployment; the session file belongs to one person.
- Keep the existing guarantees: no checkout/payment tool, no browser opened
  by the server itself.

## Docker (sketch)

No browser is needed with login A or C, so a slim Node image is enough:

```dockerfile
FROM node:22-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
# sessions/ is the only state - mount it as a volume
VOLUME ["/app/sessions"]
CMD ["node", "bin/shufersal-mcp.mjs"]
```

The TypeScript sources run directly through `tsx` (a runtime dependency), so
there is no build step. `playwright-core` is only loaded for a browser login.

## When things break

| Symptom | Likely cause | What to do |
|---|---|---|
| "Not signed in" | Session expired, no credentials configured | `npm run login`, or import a fresh session |
| "did not accept the login" | Wrong password, or Shufersal now wants a captcha/SMS | Fix the password, or use option B/C. It will not retry by itself. |
| "returned 403/429" / "challenge page" | The site refused the request | Stop. Wait, try from a home connection, or set `SHUFERSAL_TRANSPORT=browser` on a desktop. Do not loop. |
| Search works, cart edits fail with "did not apply" | The site changed its cart HTML or `cart/update` contract | Record a new HAR (see CONTRIBUTING.md) and update `docs/SHUFERSAL-API.md` + the parser |
| Totals look wrong | Promotions moved between the mini-cart and the summary page | The tool reports the summary page's own figure; compare with the website |
