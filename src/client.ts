export type NetFetch = (url: string, init?: unknown) => Promise<unknown>;

export const HUBSPOT_API_BASE = 'https://api.hubapi.com';
/** Private-app burst limit is ≥100 req/10 s and search is capped at 5 req/s;
 *  a single global 3 rps throttle stays safely under both. */
export const REQUESTS_PER_SECOND = 3;
const MIN_INTERVAL_MS = Math.ceil(1000 / REQUESTS_PER_SECOND);
const MAX_TRANSIENT_RETRIES = 4;
const TRANSIENT_BACKOFF_MS = 1_000; // 1s, 2s, 4s, 8s
const MAX_RATE_LIMIT_RETRIES = 5;

/** The host `net.fetch` surface resolves to this shape — header keys lowercase. */
interface HostResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: Uint8Array;
}

export class HubSpotApiError extends Error {
  /** Source-taxonomy code the engine keys on: 401 = bad/revoked token,
   *  403 = missing scope — both need the user to fix the Private App, so
   *  both classify as 'auth' (needsReauth) instead of burning retries. */
  readonly code?: 'auth';

  constructor(
    public httpStatus: number,
    public category: string,
    message: string,
  ) {
    super(`hubspot ${category}: ${message}`);
    this.name = 'HubSpotApiError';
    if (httpStatus === 401 || httpStatus === 403) this.code = 'auth';
  }
}

/** 401 = bad/revoked token, 403 = missing scope — both need the user to fix
 *  the Private App, so both flip the account to needsReauth. */
export const isAuthError = (e: unknown): boolean =>
  e instanceof HubSpotApiError && (e.httpStatus === 401 || e.httpStatus === 403);

export interface HubSpotClientDeps {
  fetch: NetFetch;
  token: string;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export class HubSpotClient {
  requestCount = 0;

  private lastCallAt = 0;

  private readonly fetchFn: NetFetch;

  private readonly sleepFn: (ms: number) => Promise<void>;

  private readonly now: () => number;

  constructor(private readonly deps: HubSpotClientDeps) {
    this.fetchFn = deps.fetch;
    this.sleepFn = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = deps.now ?? Date.now;
  }

  private async throttle(): Promise<void> {
    const wait = this.lastCallAt + MIN_INTERVAL_MS - this.now();
    if (wait > 0) await this.sleepFn(wait);
    this.lastCallAt = this.now();
    this.requestCount += 1;
  }

  private async raw(url: string, init: Record<string, unknown>): Promise<HostResponse> {
    let transient = 0;
    let rateLimited = 0;
    for (;;) {
      await this.throttle();
      let res: HostResponse;
      try {
        res = (await this.fetchFn(url, init)) as HostResponse;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (transient >= MAX_TRANSIENT_RETRIES)
          throw new Error(`hubspot ${url}: network error after ${transient + 1} attempts: ${msg}`);
        transient += 1;
        await this.sleepFn(TRANSIENT_BACKOFF_MS * 2 ** (transient - 1));
        continue;
      }
      if (res.status === 429) {
        if (rateLimited >= MAX_RATE_LIMIT_RETRIES)
          throw new Error(`hubspot ${url}: HTTP 429 after ${rateLimited + 1} attempts`);
        rateLimited += 1;
        // retry-after may be missing or non-numeric; default 5s, floor 1s, cap 60s.
        const rawHeader = Number(res.headers['retry-after']);
        const after = Number.isFinite(rawHeader) ? Math.min(Math.max(1, rawHeader), 60) : 5;
        await this.sleepFn(after * 1000);
        continue;
      }
      if (res.status >= 500) {
        if (transient >= MAX_TRANSIENT_RETRIES)
          throw new Error(`hubspot ${url}: HTTP ${res.status} after ${transient + 1} attempts`);
        transient += 1;
        await this.sleepFn(TRANSIENT_BACKOFF_MS * 2 ** (transient - 1));
        continue;
      }
      return res;
    }
  }

  async request<T = unknown>(method: 'GET' | 'POST', pathname: string, body?: unknown): Promise<T> {
    const res = await this.raw(`${HUBSPOT_API_BASE}${pathname}`, {
      method,
      headers: {
        authorization: `Bearer ${this.deps.token}`,
        'content-type': 'application/json',
      },
      body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
    });
    const json = JSON.parse(new TextDecoder().decode(res.body)) as T & {
      category?: string;
      message?: string;
    };
    if (res.status < 200 || res.status >= 300)
      throw new HubSpotApiError(res.status, json.category ?? 'unknown_error', json.message ?? `HTTP ${res.status}`);
    return json;
  }

  /** Fetch an absolute (signed) URL with NO auth header; returns raw bytes. */
  async download(url: string): Promise<{ bytes: Uint8Array; mime: string }> {
    const res = await this.raw(url, { method: 'GET' });
    if (res.status < 200 || res.status >= 300)
      throw new Error(`hubspot file download: HTTP ${res.status}`);
    return { bytes: res.body, mime: res.headers['content-type'] ?? 'application/octet-stream' };
  }
}
