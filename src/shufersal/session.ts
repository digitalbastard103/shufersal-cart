import path from 'node:path';
import { chromium, type BrowserContext, type Page } from 'playwright-core';

import type { ShoppingConfig } from '../config.js';
import type { StoredCookie } from './cookies.js';
import { assertNotBlocked, FormBody, NotSignedInError, probeSignedIn, SessionError, type RawResponse, type Transport } from './transport.js';
import { SHUFERSAL_HOME, SHUFERSAL_ORIGIN } from './types.js';

export { BlockedError, NotSignedInError, SessionError } from './transport.js';

type Logger = (message: string) => void;

/**
 * A real browser window used as the session container - same approach as the
 * Finance project's bank sync. You log in yourself (including any OTP); this
 * never sees or types credentials. Requests are made with `fetch` from inside
 * the page, so they carry the site's own cookies and origin. In the default
 * HTTP mode this is only used to log in; see `connect.ts`.
 */
export class ShufersalSession implements Transport {
  private context: BrowserContext | null = null;
  private page: Page | null = null;

  constructor(
    private readonly config: ShoppingConfig,
    private readonly log: Logger,
  ) {}

  /**
   * The login session lives in the persistent profile and survived between
   * runs when tested, so a window is only needed to log in. Unless
   * SHUFERSAL_HEADLESS=0, start hidden; if the profile turns out to be signed
   * out, close it and reopen visibly for the login.
   */
  async open(): Promise<void> {
    if (this.config.headless) {
      await this.launch(true);
      if (await this.isSignedIn()) {
        this.log('Still signed in from last time - running without a window.');
        return;
      }
      this.log('Not signed in - opening a window so you can log in.');
      await this.close();
    }
    await this.launch(false);
  }

  private async launch(headless: boolean): Promise<void> {
    const options: Parameters<typeof chromium.launchPersistentContext>[1] = {
      headless,
      viewport: null,
      // Playwright disables Chrome's sandbox by default - a known automation
      // fingerprint with no benefit here.
      chromiumSandbox: true,
      locale: 'he-IL',
      timezoneId: 'Asia/Jerusalem',
      // Seen live: launched from a background process, the window opened
      // behind everything else and went unnoticed for the whole login timeout.
      args: headless ? [] : ['--start-maximized'],
    };
    if (this.config.browserExecutable) options.executablePath = this.config.browserExecutable;
    else if (this.config.browserChannel) options.channel = this.config.browserChannel;

    this.context = await chromium.launchPersistentContext(path.resolve(process.cwd(), this.config.userDataDir), options);
    this.page = this.context.pages()[0] ?? (await this.context.newPage());
    await this.page.goto(SHUFERSAL_HOME, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    if (!headless) {
      await this.page.bringToFront().catch(() => {});
      this.log('A Chrome window is open on shufersal.co.il - if you do not see it, check the taskbar.');
    }
  }

  /**
   * Waits until the site treats this browser as signed in. The probe is the
   * saved-address list, which only a signed-in account has; its contents are
   * never read beyond "is it a non-empty array".
   */
  async waitForSignIn(): Promise<void> {
    const deadline = Date.now() + this.config.loginTimeoutMs;
    let asked = false;
    let lastBeat = Date.now();

    while (Date.now() < deadline) {
      const page = this.requirePage();
      if (page.url().startsWith(SHUFERSAL_ORIGIN) && (await this.isSignedIn())) {
        this.log('Signed in.');
        return;
      }
      if (!asked) {
        this.log('Please log in to Shufersal in the browser window (including the SMS code).');
        asked = true;
      }
      if (Date.now() - lastBeat >= 15_000) {
        lastBeat = Date.now();
        this.log(`Still waiting for sign-in… (${Math.round((this.config.loginTimeoutMs - (deadline - Date.now())) / 1000)}s)`);
      }
      await page.waitForTimeout(2_000).catch(() => {});
    }
    throw new NotSignedInError(`Not signed in after ${Math.round(this.config.loginTimeoutMs / 1000)}s.`);
  }

  private isSignedIn(): Promise<boolean> {
    return probeSignedIn(this);
  }

  /** The signed-in session's cookies for shufersal.co.il, for HTTP-only runs. */
  async exportCookies(): Promise<StoredCookie[]> {
    if (!this.context) throw new SessionError('The browser is not open.');
    return (await this.context.cookies())
      .filter((c) => c.domain.replace(/^\./, '').endsWith('shufersal.co.il'))
      .map((c) => ({ name: c.name, value: c.value, domain: c.domain, path: c.path, expires: c.expires, secure: c.secure }));
  }

  /** In-page fetch. POSTs carry the CSRF token the page itself exposes. */
  async request(method: 'GET' | 'POST', apiPath: string, body?: unknown): Promise<RawResponse> {
    const page = this.requirePage();
    const form = body instanceof FormBody ? body.fields : null;
    const result = await page.evaluate(
      async ({ url, method, body, form }) => {
        const headers: Record<string, string> = { 'X-Requested-With': 'XMLHttpRequest', Accept: '*/*' };
        let payload: string | undefined;
        if (method === 'POST') {
          const meta = document.querySelector('meta[name="_csrf"]')?.getAttribute('content');
          const acc = (window as unknown as { ACC?: { config?: { CSRFToken?: string } } }).ACC?.config?.CSRFToken;
          const token = meta || acc;
          if (!token) return { error: 'no CSRF token on the page' };
          if (form) {
            headers['Content-Type'] = 'application/x-www-form-urlencoded; charset=UTF-8';
            payload = new URLSearchParams({ ...form, CSRFToken: token }).toString();
          } else {
            headers['csrftoken'] = token;
            headers['Content-Type'] = 'application/json';
            payload = body === undefined ? undefined : JSON.stringify(body);
          }
        }
        try {
          const response = await fetch(url, { method, credentials: 'include', headers, body: payload });
          return {
            status: response.status,
            contentType: response.headers.get('content-type') ?? '',
            finalUrl: response.url,
            text: await response.text(),
          };
        } catch (error) {
          return { error: error instanceof Error ? error.message : String(error) };
        }
      },
      { url: `${SHUFERSAL_ORIGIN}${apiPath}`, method, body: form ? undefined : body, form },
    );

    if ('error' in result) throw new SessionError(`${method} ${apiPath}: ${result.error}`);
    assertNotBlocked(method, apiPath, result);
    return result;
  }

  async pause(ms: number): Promise<void> {
    await this.requirePage().waitForTimeout(ms).catch(() => {});
  }

  async close(): Promise<void> {
    const context = this.context;
    this.context = null;
    this.page = null;
    await context?.close().catch(() => {});
  }

  private requirePage(): Page {
    if (!this.page || this.page.isClosed()) throw new SessionError('The browser window was closed.');
    return this.page;
  }
}
