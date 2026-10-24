import { ENDPOINTS } from './types.js';

export class SessionError extends Error {}
/** The site refused or challenged us (403/429, captcha, block page). Stop - don't retry. */
export class BlockedError extends SessionError {}
export class NotSignedInError extends SessionError {}
/**
 * The site refused a username/password login. Never retried automatically:
 * repeated failed logins can lock the account or bring in a captcha/SMS step.
 */
export class LoginRejectedError extends SessionError {}

export type RawResponse = { status: number; contentType: string; finalUrl: string; text: string };

/**
 * How requests reach shufersal.co.il. Two implementations:
 *  - `HttpSession`: plain Node `fetch` with saved session cookies (no browser)
 *  - `ShufersalSession`: `fetch` inside a real Chrome page (used to log in)
 */
/**
 * POST bodies come in two shapes on this site: JSON with a `csrftoken`
 * header (cart/addGrid, slots), and a form with `CSRFToken` as a field
 * (cart/update). A `FormBody` selects the second.
 */
export class FormBody {
  constructor(readonly fields: Record<string, string>) {}
}

export interface Transport {
  /** POSTs carry the session's CSRF token (header for JSON, field for FormBody). */
  request(method: 'GET' | 'POST', apiPath: string, body?: unknown): Promise<RawResponse>;
  pause(ms: number): Promise<void>;
  close(): Promise<void>;
}

/** Shared refusal rules: a block or challenge stops the run, it is never retried. */
export function assertNotBlocked(method: string, apiPath: string, response: RawResponse): void {
  if (response.status === 403 || response.status === 429) {
    throw new BlockedError(`${method} ${apiPath} returned ${response.status} - the site refused the request. Stopping.`);
  }
  if (/captcha|challenge/i.test(response.finalUrl) || /g-recaptcha|cf-challenge|px-captcha/i.test(response.text.slice(0, 4000))) {
    throw new BlockedError(`${method} ${apiPath} was answered with a challenge page. Stopping.`);
  }
}

/**
 * "Signed in" = the saved-address list is a non-empty JSON array, which only a
 * logged-in account has. The addresses themselves are never printed or kept.
 */
export async function probeSignedIn(transport: Transport): Promise<boolean> {
  try {
    const response = await transport.request('GET', ENDPOINTS.addressList);
    if (response.status !== 200 || !response.contentType.includes('json')) return false;
    const body: unknown = JSON.parse(response.text);
    return Array.isArray(body) && body.length > 0;
  } catch (error) {
    if (error instanceof BlockedError) throw error;
    return false;
  }
}
