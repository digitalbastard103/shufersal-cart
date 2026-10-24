# Contributing

## Setup

```bash
npm install
npm run typecheck
npm test            # offline - fakes only, no account or network needed
```

Node 22.5+. The sources are TypeScript run directly by `tsx`; there is no build.

## Ground rules

These are what make the tool safe to point at a real account. Changes that
break them will not be merged.

1. **No checkout, no payment.** The tool prepares a cart; a person pays.
2. **Never guess a write request.** Every POST mirrors a request recorded from
   the real website, field for field. If you have not seen it in a HAR, don't
   send it.
3. **Never guess which product the user meant.** Ambiguity is reported, not
   resolved by the code.
4. **No captcha solving, no bot-detection evasion, no disguised user agents.**
   If the site refuses (403/429/challenge), stop. If it starts requiring a
   captcha or SMS code to log in, the password login stops working — that is
   the intended behaviour.
5. **Failed logins are never retried automatically.**
6. **Credentials and personal data never leave the process.** No logging of
   passwords, cookies, addresses, phone numbers or emails; tests use fake data.
7. **Verify, don't assume:** after a change, read the cart back and confirm it.

## Recording a HAR safely

New features start from a recording of doing the thing on the website.

1. Chrome → DevTools (F12) → Network → tick **Preserve log**.
2. Do the action once on shufersal.co.il.
3. Wait until the page is idle, then right-click the request list →
   **Save all as HAR**. Large HARs can be cut off mid-export; if parsing
   fails, the complete entries can still be recovered (see below).
4. **A HAR contains your session cookies, CSRF tokens, addresses, phone number
   and order history — and a login HAR contains your password.** Never commit
   or share it. `*.har` is gitignored. Delete it when done, and log out or
   change your password if a login HAR was ever shared.

To read it, filter to the site's own requests and print field *names*, not
values. For a truncated HAR, scan the `entries` array object by object and
`JSON.parse` each complete one.

## Adding or changing an endpoint

1. Record it (above).
2. Document the contract in `docs/SHUFERSAL-API.md` — request, response,
   quirks, and whether it was captured or found in JS.
3. Add the path to `ENDPOINTS` and a pure parser to `src/shufersal/types.ts`.
   Test the parser with a **redacted** copy of the real response.
4. Add a method to `ShufersalClient` that enforces the operation's invariants
   (fresh entry numbers, verification, input limits).
5. Expose it in `src/cli/` and/or `src/mcp/server.ts`.
6. Try it against your own account: read-only first, then a reversible change
   (add then remove), checking the cart in the app.

## Tests

- `test/*.test.ts`, run with `npm test`.
- `FakeSite` in `test/cart.test.ts` and the fake `fetch` in
  `test/login.test.ts` model the site's behaviour (including cart
  renumbering and login redirects). Extend them rather than calling the real
  site from tests.
- `test/mcp.test.ts` drives the MCP server through an in-memory client.
- There are no live tests in CI; live checks are manual (see step 6 above).

## Code style

- Small modules, typed boundaries, comments that explain *why* (what was
  observed on the site), not what the next line does.
- Keep `types.ts` free of I/O.
- In code used by the MCP server, never write to stdout.
