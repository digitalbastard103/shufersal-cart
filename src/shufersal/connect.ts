import fs from 'node:fs';
import path from 'node:path';

import type { ShoppingConfig } from '../config.js';
import { CookieJar } from './cookies.js';
import { HttpSession } from './http-session.js';
import { ShufersalSession } from './session.js';
import { LoginRejectedError, NotSignedInError, probeSignedIn, SessionError, type Transport } from './transport.js';

type Logger = (message: string) => void;

export type ConnectOptions = {
  /**
   * true (CLI default): if nothing else works, open Chrome so the owner can
   * log in. false (MCP server): never open a browser on its own - throw
   * NotSignedInError and let the caller ask for an explicit login.
   * A configured username/password is used either way; it needs no browser.
   */
  allowBrowserLogin?: boolean;
};

export type LoginMethod = 'auto' | 'password' | 'browser';

/**
 * Set when the site rejected a password login in this process. Automatic
 * logins stop until an explicit `login(...)` - failed logins are never looped.
 */
let passwordRejected: string | null = null;

export function hasCredentials(config: ShoppingConfig): boolean {
  return Boolean(config.username && config.password);
}

/**
 * Returns a signed-in transport, trying in order:
 *  1. the saved session cookies (no browser, no password)
 *  2. username/password from the environment, if configured (no browser)
 *  3. a browser login, if allowed
 *
 * Browser mode (SHUFERSAL_TRANSPORT=browser): every request runs inside Chrome.
 */
export async function connect(config: ShoppingConfig, log: Logger, options: ConnectOptions = {}): Promise<Transport> {
  const allowBrowser = options.allowBrowserLogin ?? true;

  if (config.transport === 'browser') {
    if (!allowBrowser) throw new SessionError('Browser transport is not available here; use SHUFERSAL_TRANSPORT=http.');
    const browser = new ShufersalSession(config, log);
    await browser.open();
    await browser.waitForSignIn();
    return browser;
  }

  const saved = await savedSession(config, log);
  if (saved) return saved;

  if (hasCredentials(config) && !passwordRejected) return passwordLogin(config, log);

  if (!allowBrowser) {
    throw new NotSignedInError(
      passwordRejected
        ? `Not signed in to Shufersal. The stored password login was rejected earlier (${passwordRejected}).`
        : 'Not signed in to Shufersal (no saved session, or it has expired, and no SHUFERSAL_USERNAME/SHUFERSAL_PASSWORD configured).',
    );
  }
  return browserLogin(config, log);
}

/** An explicit login - the CLI `login` command and the MCP `login` tool. Clears an earlier rejection. */
export async function login(config: ShoppingConfig, log: Logger, method: LoginMethod = 'auto'): Promise<HttpSession> {
  passwordRejected = null;
  if (method === 'password' || (method === 'auto' && hasCredentials(config))) return passwordLogin(config, log);
  return browserLogin(config, log);
}

/** The saved HTTP session if it still works; a dead cookie file is deleted. */
export async function savedSession(config: ShoppingConfig, log: Logger): Promise<HttpSession | null> {
  const cookieFile = path.resolve(process.cwd(), config.cookieFile);
  const saved = CookieJar.load(cookieFile);
  if (!saved || saved.size === 0) return null;

  const http = new HttpSession(saved, cookieFile);
  if (await probeSignedIn(http)) {
    log('Signed in with the saved session - no browser.');
    return http;
  }
  log('The saved session has expired.');
  fs.rmSync(cookieFile, { force: true });
  return null;
}

/** Username/password over HTTP - no browser. One attempt; a rejection is remembered, never looped. */
export async function passwordLogin(config: ShoppingConfig, log: Logger): Promise<HttpSession> {
  if (!config.username || !config.password) {
    throw new SessionError('SHUFERSAL_USERNAME and SHUFERSAL_PASSWORD are not set.');
  }
  const cookieFile = path.resolve(process.cwd(), config.cookieFile);
  const jar = new CookieJar();
  const http = new HttpSession(jar, cookieFile);
  log('Logging in with the stored username and password (no browser)…');
  try {
    await http.passwordLogin(config.username, config.password);
    if (!(await probeSignedIn(http))) {
      throw new LoginRejectedError('The login form was accepted, but the session is not signed in.');
    }
  } catch (error) {
    if (error instanceof LoginRejectedError) passwordRejected = error.message;
    throw error;
  }
  jar.save(cookieFile);
  log('Signed in - session saved.');
  return http;
}

/**
 * Logs in through Chrome on the tool's own profile - hidden if that profile is
 * still signed in, otherwise a visible window where the owner logs in
 * (password, SMS code, any captcha) - then saves the session cookies for
 * browser-free use and closes the browser. Never handles credentials itself.
 * Needs a desktop: it cannot show a window on a headless server.
 */
export async function browserLogin(config: ShoppingConfig, log: Logger): Promise<HttpSession> {
  const cookieFile = path.resolve(process.cwd(), config.cookieFile);
  const browser = new ShufersalSession(config, log);
  let cookies;
  try {
    await browser.open();
    await browser.waitForSignIn();
    cookies = await browser.exportCookies();
  } finally {
    await browser.close();
  }

  const jar = new CookieJar(cookies);
  const http = new HttpSession(jar, cookieFile);
  if (!(await probeSignedIn(http))) {
    throw new SessionError(
      'You are logged in in the browser, but the session does not work outside it. ' +
        'Use SHUFERSAL_TRANSPORT=browser to keep running inside Chrome.',
    );
  }
  jar.save(cookieFile);
  log('Session saved - next runs need no browser until it expires.');
  return http;
}
