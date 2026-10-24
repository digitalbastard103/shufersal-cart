import { CookieJar } from './cookies.js';
import { assertNotBlocked, FormBody, LoginRejectedError, SessionError, type RawResponse, type Transport } from './transport.js';
import { SHUFERSAL_HOME, SHUFERSAL_ORIGIN } from './types.js';

/**
 * Talks to the site's endpoints directly from Node - no browser - using the
 * cookies saved after a browser login. Headers mirror what the site's own
 * page sends (taken from the capture), except the User-Agent: it is left as
 * Node's own rather than pretending to be Chrome. If the site ever refuses
 * that, the browser transport (SHUFERSAL_TRANSPORT=browser) is the fallback.
 */
export class HttpSession implements Transport {
  private csrf: string | null = null;

  constructor(
    private readonly jar: CookieJar,
    private readonly cookieFile: string,
  ) {}

  async request(method: 'GET' | 'POST', apiPath: string, body?: unknown): Promise<RawResponse> {
    const url = `${SHUFERSAL_ORIGIN}${apiPath}`;
    const headers: Record<string, string> = {
      Accept: '*/*',
      'Accept-Language': 'he-IL,he;q=0.9,en;q=0.8',
      'X-Requested-With': 'XMLHttpRequest',
      Referer: SHUFERSAL_HOME,
    };
    let payload: string | undefined;
    if (method === 'POST') {
      const token = await this.csrfToken();
      headers['Origin'] = SHUFERSAL_ORIGIN;
      if (body instanceof FormBody) {
        headers['Content-Type'] = 'application/x-www-form-urlencoded; charset=UTF-8';
        payload = new URLSearchParams({ ...body.fields, CSRFToken: token }).toString();
      } else {
        headers['csrftoken'] = token;
        headers['Content-Type'] = 'application/json';
        payload = body === undefined ? undefined : JSON.stringify(body);
      }
    }
    const response = await this.send(url, method, headers, payload);
    assertNotBlocked(method, apiPath, response);
    return response;
  }

  /**
   * Username/password login without a browser: the site's own Spring Security
   * form post, field for field as captured from a real login (2026-10):
   *
   *   POST /online/he/j_spring_security_check  (form)
   *     fail_url=/login/?error=true & j_username & j_password & remember-me=True & CSRFToken
   *   -> 302 /online/he/login?redirect_url -> 302 /online/he/A   on success
   *   -> 302 /login/?error=true                                on failure
   *
   * That capture had no captcha and no SMS code. If the site ever adds one,
   * the login lands back on the login page and this throws instead of trying
   * again. Credentials are only ever sent to this one endpoint and never logged.
   */
  async passwordLogin(username: string, password: string): Promise<void> {
    const loginPage = await this.send(`${SHUFERSAL_ORIGIN}/online/he/login`, 'GET', { Accept: 'text/html', 'Accept-Language': 'he-IL,he;q=0.9' });
    assertNotBlocked('GET', '/online/he/login', loginPage);
    const token =
      /<meta\s+name="_csrf"\s+content="([^"]+)"/.exec(loginPage.text)?.[1] ?? /name="CSRFToken"\s+value="([^"]+)"/.exec(loginPage.text)?.[1];
    if (!token) throw new SessionError('No CSRF token on the login page.');

    const form = new URLSearchParams({
      fail_url: '/login/?error=true',
      j_username: username,
      j_password: password,
      'remember-me': 'True',
      CSRFToken: token,
    }).toString();
    const result = await this.send(
      `${SHUFERSAL_ORIGIN}/online/he/j_spring_security_check`,
      'POST',
      {
        Accept: 'text/html',
        'Accept-Language': 'he-IL,he;q=0.9',
        'Content-Type': 'application/x-www-form-urlencoded',
        Origin: SHUFERSAL_ORIGIN,
        Referer: `${SHUFERSAL_ORIGIN}/online/he/login`,
      },
      form,
    );
    this.csrf = null; // a new session gets a new token
    assertNotBlocked('POST', '/online/he/j_spring_security_check', result);
    if (/error=true/.test(result.finalUrl) || /\/login\/?$/.test(new URL(result.finalUrl).pathname)) {
      throw new LoginRejectedError(
        'Shufersal did not accept the login (wrong username/password, or it now asks for a captcha or SMS code). ' +
          'Not retrying. Log in through the browser instead (npm run login -- --browser).',
      );
    }
  }

  /**
   * The CSRF token is tied to the session and printed into every page as
   * `<meta name="_csrf" content="...">` (confirmed in the capture).
   */
  private async csrfToken(): Promise<string> {
    if (this.csrf) return this.csrf;
    const page = await this.send(SHUFERSAL_HOME, 'GET', { Accept: 'text/html', 'Accept-Language': 'he-IL,he;q=0.9' });
    assertNotBlocked('GET', '/online/he/A', page);
    const token = /<meta\s+name="_csrf"\s+content="([^"]+)"/.exec(page.text)?.[1];
    if (!token) throw new SessionError('No CSRF token on the home page - the saved session may have expired.');
    this.csrf = token;
    return token;
  }

  private async send(url: string, method: string, headers: Record<string, string>, body?: string): Promise<RawResponse> {
    let current = url;
    // Follow redirects by hand so Set-Cookie on each hop lands in the jar.
    for (let hop = 0; hop < 5; hop += 1) {
      const cookie = this.jar.header(current);
      let response: Response;
      try {
        response = await fetch(current, {
          method: hop === 0 ? method : 'GET',
          headers: cookie ? { ...headers, Cookie: cookie } : headers,
          body: hop === 0 ? body : undefined,
          redirect: 'manual',
        });
      } catch (error) {
        throw new SessionError(`${method} ${new URL(url).pathname}: ${error instanceof Error ? error.message : String(error)}`);
      }
      this.jar.absorb(current, response.headers.getSetCookie());
      const location = response.headers.get('location');
      if (response.status >= 300 && response.status < 400 && location) {
        current = new URL(location, current).toString();
        continue;
      }
      return {
        status: response.status,
        contentType: response.headers.get('content-type') ?? '',
        finalUrl: current,
        text: await response.text(),
      };
    }
    throw new SessionError(`${method} ${new URL(url).pathname}: too many redirects`);
  }

  async pause(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  /** Persists renewed / rotated cookies so the next run keeps the session. */
  async close(): Promise<void> {
    this.jar.save(this.cookieFile);
  }
}
