import fs from 'node:fs';
import path from 'node:path';

/**
 * Session cookies for shufersal.co.il, saved after you log in in the browser.
 *
 * This file is effectively a logged-in key to the Shufersal account: anyone
 * holding it can act as you on the site until the session expires. It lives
 * under `sessions/` (gitignored), is never printed, and is deleted when the
 * session is found to be dead.
 */

export type StoredCookie = {
  name: string;
  value: string;
  /** "www.shufersal.co.il" (host-only) or ".shufersal.co.il" (subdomains too) */
  domain: string;
  path: string;
  /** Unix seconds; -1 = session cookie */
  expires: number;
  secure: boolean;
};

export class CookieJar {
  private readonly cookies = new Map<string, StoredCookie>();

  constructor(initial: StoredCookie[] = []) {
    for (const c of initial) this.set(c);
  }

  static load(file: string): CookieJar | null {
    if (!fs.existsSync(file)) return null;
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { cookies?: StoredCookie[] };
      return Array.isArray(parsed.cookies) ? new CookieJar(parsed.cookies) : null;
    } catch {
      return null;
    }
  }

  save(file: string): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ savedAt: new Date().toISOString(), cookies: this.all() }, null, 2), 'utf8');
  }

  all(now = Date.now()): StoredCookie[] {
    return [...this.cookies.values()].filter((c) => c.expires === -1 || c.expires * 1000 > now);
  }

  get size(): number {
    return this.all().length;
  }

  /** The `Cookie` header value for a request to `url`. */
  header(url: string, now = Date.now()): string {
    const u = new URL(url);
    return this.all(now)
      .filter((c) => domainMatches(u.hostname, c.domain) && u.pathname.startsWith(c.path || '/') && (!c.secure || u.protocol === 'https:'))
      .map((c) => `${c.name}=${c.value}`)
      .join('; ');
  }

  /** Applies a response's `Set-Cookie` headers (rotation, renewal, deletion). */
  absorb(url: string, setCookieHeaders: string[], now = Date.now()): void {
    for (const line of setCookieHeaders) {
      const parsed = parseSetCookie(line, new URL(url).hostname, now);
      if (parsed) this.set(parsed);
    }
  }

  private set(cookie: StoredCookie): void {
    const key = `${cookie.name}|${cookie.domain.replace(/^\./, '')}|${cookie.path}`;
    if (cookie.expires !== -1 && cookie.expires * 1000 <= Date.now()) this.cookies.delete(key);
    else this.cookies.set(key, cookie);
  }
}

function domainMatches(host: string, cookieDomain: string): boolean {
  if (cookieDomain.startsWith('.')) {
    const bare = cookieDomain.slice(1);
    return host === bare || host.endsWith(`.${bare}`);
  }
  return host === cookieDomain;
}

export function parseSetCookie(line: string, requestHost: string, now = Date.now()): StoredCookie | null {
  const [pair, ...attrs] = line.split(';');
  const eq = pair?.indexOf('=') ?? -1;
  if (!pair || eq <= 0) return null;

  const cookie: StoredCookie = {
    name: pair.slice(0, eq).trim(),
    value: pair.slice(eq + 1).trim(),
    domain: requestHost,
    path: '/',
    expires: -1,
    secure: false,
  };

  let maxAge: number | null = null;
  for (const attr of attrs) {
    const [rawKey, ...rest] = attr.split('=');
    const key = rawKey?.trim().toLowerCase();
    const value = rest.join('=').trim();
    if (key === 'domain' && value) cookie.domain = `.${value.replace(/^\./, '')}`;
    else if (key === 'path' && value) cookie.path = value;
    else if (key === 'secure') cookie.secure = true;
    else if (key === 'max-age' && /^-?\d+$/.test(value)) maxAge = Number.parseInt(value, 10);
    else if (key === 'expires') {
      const t = Date.parse(value);
      if (Number.isFinite(t)) cookie.expires = Math.floor(t / 1000);
    }
  }
  // Max-Age wins over Expires (RFC 6265).
  if (maxAge !== null) cookie.expires = Math.floor(now / 1000) + maxAge;
  return cookie;
}
