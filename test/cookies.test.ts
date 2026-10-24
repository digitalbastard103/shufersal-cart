import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { CookieJar, parseSetCookie, type StoredCookie } from '../src/shufersal/cookies.js';

const NOW = Date.parse('2026-10-24T12:00:00Z');
const c = (name: string, extra: Partial<StoredCookie> = {}): StoredCookie => ({
  name,
  value: `${name}-v`,
  domain: '.shufersal.co.il',
  path: '/',
  expires: -1,
  secure: true,
  ...extra,
});

describe('CookieJar', () => {
  it('sends only cookies whose domain, path and scheme match the request', () => {
    const jar = new CookieJar([
      c('wide'),
      c('host', { domain: 'www.shufersal.co.il' }),
      c('api', { domain: 'api.shufersal.co.il' }),
      c('deep', { path: '/online/he/cart' }),
      c('other', { domain: '.example.com' }),
    ]);
    expect(jar.header('https://www.shufersal.co.il/online/he/search/results', NOW)).toBe('wide=wide-v; host=host-v');
    expect(jar.header('https://www.shufersal.co.il/online/he/cart/add', NOW)).toBe('wide=wide-v; host=host-v; deep=deep-v');
    expect(jar.header('http://www.shufersal.co.il/', NOW)).toBe('');
  });

  it('drops expired cookies', () => {
    const jar = new CookieJar([c('old', { expires: NOW / 1000 - 10 }), c('live', { expires: NOW / 1000 + 3600 })]);
    expect(jar.header('https://www.shufersal.co.il/', NOW)).toBe('live=live-v');
  });

  it('applies rotated and deleted cookies from Set-Cookie', () => {
    const jar = new CookieJar([c('JSESSIONID', { domain: 'www.shufersal.co.il' }), c('gone')]);
    jar.absorb(
      'https://www.shufersal.co.il/online/he/cart/add',
      ['JSESSIONID=rotated; Path=/; Secure; HttpOnly', 'gone=; Max-Age=0; Domain=shufersal.co.il; Path=/'],
      NOW,
    );
    expect(jar.header('https://www.shufersal.co.il/x', NOW)).toBe('JSESSIONID=rotated');
  });

  it('round-trips through the file', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jar-')), 'cookies.json');
    new CookieJar([c('a')]).save(file);
    expect(CookieJar.load(file)!.header('https://www.shufersal.co.il/')).toBe('a=a-v');
    expect(CookieJar.load(path.join(path.dirname(file), 'missing.json'))).toBeNull();
  });
});

describe('parseSetCookie', () => {
  it('reads domain, path, secure and Max-Age (which beats Expires)', () => {
    expect(
      parseSetCookie('x=1; Domain=.shufersal.co.il; Path=/online; Secure; Expires=Wed, 01 Jan 2031 00:00:00 GMT; Max-Age=60', 'www.shufersal.co.il', NOW),
    ).toEqual({ name: 'x', value: '1', domain: '.shufersal.co.il', path: '/online', expires: NOW / 1000 + 60, secure: true });
  });

  it('defaults to a host-only session cookie', () => {
    expect(parseSetCookie('y=a=b', 'www.shufersal.co.il', NOW)).toEqual({
      name: 'y',
      value: 'a=b',
      domain: 'www.shufersal.co.il',
      path: '/',
      expires: -1,
      secure: false,
    });
  });

  it('rejects junk', () => {
    expect(parseSetCookie('=nope', 'h', NOW)).toBeNull();
    expect(parseSetCookie('', 'h', NOW)).toBeNull();
  });
});
