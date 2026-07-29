import { HubSpotApiError, HubSpotClient, isAuthError, HUBSPOT_API_BASE } from '../client';
import { ALL_TYPES, DOC_TYPE, LAST_MODIFIED_PROP } from '../types';

const enc = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));
const res = (status: number, body: unknown, headers: Record<string, string> = {}) => ({
  status,
  statusText: '',
  headers,
  body: enc(body),
});

function makeClient(responses: Array<ReturnType<typeof res>>, calls: Array<{ url: string; init: any }> = []) {
  let i = 0;
  const sleeps: number[] = [];
  const client = new HubSpotClient({
    fetch: async (url, init) => {
      calls.push({ url, init });
      if (i >= responses.length) throw new Error('unexpected extra request');
      return responses[i++];
    },
    token: 'pat-na1-test',
    sleep: async (ms) => { sleeps.push(ms); },
    now: (() => { let t = 0; return () => (t += 1000); })(),
  });
  return { client, sleeps, calls };
}

describe('type maps', () => {
  it('covers every type key', () => {
    for (const t of ALL_TYPES) {
      expect(DOC_TYPE[t]).toMatch(/^hubspot\./);
      expect(LAST_MODIFIED_PROP[t]).toBe(t === 'contacts' ? 'lastmodifieddate' : 'hs_lastmodifieddate');
    }
  });
});

describe('HubSpotClient.request', () => {
  it('sends bearer auth and parses JSON', async () => {
    const calls: Array<{ url: string; init: any }> = [];
    const { client } = makeClient([res(200, { portalId: 123 })], calls);
    const out = await client.request<{ portalId: number }>('GET', '/account-info/v3/details');
    expect(out.portalId).toBe(123);
    expect(calls[0].url).toBe(`${HUBSPOT_API_BASE}/account-info/v3/details`);
    expect(calls[0].init.headers.authorization).toBe('Bearer pat-na1-test');
    expect(client.requestCount).toBe(1);
  });

  it('retries 429 honoring retry-after (clamped), then succeeds', async () => {
    const { client, sleeps } = makeClient([
      res(429, {}, { 'retry-after': '2' }),
      res(429, {}, { 'retry-after': '999' }),
      res(200, { ok: true }),
    ]);
    await client.request('GET', '/x');
    expect(sleeps).toContain(2000);
    expect(sleeps).toContain(60000); // 999 clamped to 60s
  });

  it('retries 5xx with exponential backoff and gives up after 4 retries', async () => {
    const { client } = makeClient(Array.from({ length: 5 }, () => res(500, {})));
    await expect(client.request('GET', '/x')).rejects.toThrow(/HTTP 500 after 5 attempts/);
  });

  it('throws HubSpotApiError with category on 4xx and tags auth errors', async () => {
    const { client } = makeClient([res(401, { category: 'INVALID_AUTHENTICATION', message: 'bad token' })]);
    try {
      await client.request('GET', '/x');
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(HubSpotApiError);
      expect((e as HubSpotApiError).httpStatus).toBe(401);
      expect(isAuthError(e)).toBe(true);
      // Source-taxonomy contract: the engine reads the `code` property to
      // commit needsReauth — 401/403 must carry it, other statuses must not.
      expect((e as HubSpotApiError).code).toBe('auth');
    }
    expect(isAuthError(new Error('nope'))).toBe(false);
    expect(new HubSpotApiError(403, 'MISSING_SCOPES', 'no scope').code).toBe('auth');
    expect(new HubSpotApiError(404, 'NOT_FOUND', 'gone').code).toBeUndefined();
    expect(new HubSpotApiError(429, 'RATE_LIMIT', 'slow down').code).toBeUndefined();
  });

  it('POSTs a JSON body', async () => {
    const calls: Array<{ url: string; init: any }> = [];
    const { client } = makeClient([res(200, { results: [] })], calls);
    await client.request('POST', '/crm/v3/objects/contacts/search', { limit: 100 });
    expect(calls[0].init.method).toBe('POST');
    expect(JSON.parse(calls[0].init.body)).toEqual({ limit: 100 });
  });
});

describe('HubSpotClient.download', () => {
  it('fetches an absolute URL without auth and returns bytes + mime', async () => {
    const calls: Array<{ url: string; init: any }> = [];
    const { client } = makeClient(
      [{ status: 200, statusText: '', headers: { 'content-type': 'application/pdf' }, body: new Uint8Array([1, 2, 3]) }],
      calls,
    );
    const out = await client.download('https://signed.example/f.pdf');
    expect(Array.from(out.bytes)).toEqual([1, 2, 3]);
    expect(out.mime).toBe('application/pdf');
    expect(calls[0].url).toBe('https://signed.example/f.pdf');
    expect(calls[0].init?.headers?.authorization).toBeUndefined();
  });

  it('throws on non-2xx download', async () => {
    const { client } = makeClient([{ status: 403, statusText: '', headers: {}, body: new Uint8Array() }]);
    await expect(client.download('https://signed.example/f.pdf')).rejects.toThrow(/403/);
  });
});
