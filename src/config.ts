import fs from 'node:fs';
import path from 'node:path';

/** Minimal .env loader; never overrides variables already in the environment. */
export function loadDotEnv(file = '.env'): void {
  const full = path.resolve(process.cwd(), file);
  if (!fs.existsSync(full)) return;
  for (const line of fs.readFileSync(full, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    if (key === '' || key in process.env) continue;
    process.env[key] = trimmed.slice(eq + 1).trim().replace(/^(['"])(.*)\1$/, '$2');
  }
}

function optional(key: string): string | undefined {
  const value = process.env[key];
  return value === undefined || value.trim() === '' ? undefined : value.trim();
}

function int(key: string, fallback: number): number {
  const raw = optional(key);
  if (raw === undefined) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${key} must be a non-negative integer, got "${raw}"`);
  return parsed;
}

export type ShoppingConfig = {
  browserChannel?: string;
  browserExecutable?: string;
  userDataDir: string;
  /**
   * Optional, set by the account owner (env / secret store), never by an
   * assistant. When both are set, logins happen over HTTP with no browser.
   */
  username?: string;
  password?: string;
  /** 'http' (default): no browser after login. 'browser': every request inside Chrome. */
  transport: 'http' | 'browser';
  /** Saved session cookies for HTTP mode - a logged-in key, keep private. */
  cookieFile: string;
  /** Start hidden and only show a window when a login is needed. */
  headless: boolean;
  loginTimeoutMs: number;
  requestDelayMs: number;
};

export function loadConfig(): ShoppingConfig {
  return {
    browserChannel: optional('SHUFERSAL_BROWSER_CHANNEL') ?? 'chrome',
    browserExecutable: optional('SHUFERSAL_BROWSER_EXECUTABLE'),
    userDataDir: optional('SHUFERSAL_USER_DATA_DIR') ?? 'sessions/shufersal',
    headless: optional('SHUFERSAL_HEADLESS') !== '0',
    username: optional('SHUFERSAL_USERNAME'),
    password: process.env['SHUFERSAL_PASSWORD'] || undefined, // not trimmed: spaces may be part of it
    transport: optional('SHUFERSAL_TRANSPORT') === 'browser' ? 'browser' : 'http',
    cookieFile: optional('SHUFERSAL_COOKIE_FILE') ?? 'sessions/shufersal-cookies.json',
    loginTimeoutMs: int('SHUFERSAL_LOGIN_TIMEOUT_SECONDS', 300) * 1000,
    requestDelayMs: int('SHUFERSAL_REQUEST_DELAY_MS', 1200),
  };
}
