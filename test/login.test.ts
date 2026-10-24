import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ShoppingConfig } from '../src/config.js';
import { connect, login } from '../src/shufersal/connect.js';
import { LoginRejectedError, NotSignedInError } from '../src/shufersal/transport.js';

type Call = { url: string; method: string; body?: string; headers: Record<string, string> };

/** A fake shufersal.co.il implementing just the captured login flow (2026-10). */
function fakeSite(acceptPassword: string) {
  const calls: Call[] = [];
  let signedIn = false;
  const page = (status: number, body: string, extra: Record<string, string> = {}) =>
    new Response(body, { status, headers: { 'content-type': 'text/html', ...extra } });

  vi.stubGlobal('fetch', async (input: string, init: RequestInit = {}) => {
    const url = new URL(input);
    const call: Call = { url: url.pathname + url.search, method: init.method ?? 'GET', headers: (init.headers ?? {}) as Record<string, string> };
    if (typeof init.body === 'string') call.body = init.body;
    calls.push(call);

    if (url.pathname === '/online/he/login' && call.method === 'GET') {
      if (signedIn && url.searchParams.has('redirect_url')) return page(302, '', { location: '/online/he/A' });
      return page(200, '<meta name="_csrf" content="csrf-123"><form><input name="j_password"></form>', { 'set-cookie': 'JSESSIONID=anon; Path=/' });
    }
    if (url.pathname === '/online/he/j_spring_security_check') {
      const form = new URLSearchParams(call.body);
      if (form.get('j_password') === acceptPassword && form.get('CSRFToken') === 'csrf-123') {
        signedIn = true;
        return page(302, '', { location: '/online/he/login?redirect_url=%2F', 'set-cookie': 'JSESSIONID=user; Path=/' });
      }
      return page(302, '', { location: '/online/he/login/?error=true' });
    }
    if (url.pathname === '/online/he/A') return page(200, '<meta name="_csrf" content="csrf-456">');
    if (url.pathname === '/online/he/checkout/address/list') {
      const cookie = call.headers['Cookie'] ?? '';
      return new Response(cookie.includes('JSESSIONID=user') ? '[{"id":"1"}]' : '[]', { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return page(404, 'not found');
  });
  return calls;
}

function config(password: string): ShoppingConfig {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shufersal-login-'));
  return {
    userDataDir: path.join(dir, 'profile'),
    transport: 'http',
    cookieFile: path.join(dir, 'cookies.json'),
    choicesFile: path.join(dir, 'choices.json'),
    headless: true,
    loginTimeoutMs: 1000,
    requestDelayMs: 0,
    username: 'someone@example.com',
    password,
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('password login (no browser)', () => {
  it('posts exactly the captured form, follows the redirects, and saves the session', async () => {
    const calls = fakeSite('right');
    const cfg = config('right');
    await login(cfg, () => {}, 'password');

    const post = calls.find((c) => c.url === '/online/he/j_spring_security_check')!;
    expect(post.method).toBe('POST');
    expect(post.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(Object.fromEntries(new URLSearchParams(post.body))).toEqual({
      fail_url: '/login/?error=true',
      j_username: 'someone@example.com',
      j_password: 'right',
      'remember-me': 'True',
      CSRFToken: 'csrf-123',
    });
    expect(post.headers['Cookie']).toContain('JSESSIONID=anon');
    expect(fs.existsSync(cfg.cookieFile)).toBe(true);
    // The password is never written to the session file.
    expect(fs.readFileSync(cfg.cookieFile, 'utf8')).not.toContain('right');
  });

  it('throws on a rejected login and never retries it automatically', async () => {
    const calls = fakeSite('right');
    const cfg = config('wrong');

    await expect(connect(cfg, () => {}, { allowBrowserLogin: false })).rejects.toBeInstanceOf(LoginRejectedError);
    const attempts = () => calls.filter((c) => c.url === '/online/he/j_spring_security_check').length;
    expect(attempts()).toBe(1);

    // Later automatic connects report "not signed in" instead of trying again.
    await expect(connect(cfg, () => {}, { allowBrowserLogin: false })).rejects.toBeInstanceOf(NotSignedInError);
    expect(attempts()).toBe(1);

    // An explicit login is the only way to try again.
    await expect(login(cfg, () => {}, 'password')).rejects.toBeInstanceOf(LoginRejectedError);
    expect(attempts()).toBe(2);
  });
});
