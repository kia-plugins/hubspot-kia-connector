import { batchReadAssociations, delta, DELTA_REQUEST_BUDGET, OVERLAP_MS } from '../delta';
import type { Batch, Session } from '@kiagent/connector-sdk';
import { INCREMENTAL_TYPES, type HubSpotCursor, type HubSpotItem, type IncrementalTypeKey, type LiveCursor, type RenderContext, type TypeKey } from '../types';

const ctx: RenderContext = { portalId: '1', owners: {}, dealStages: {}, ticketStages: {}, customProps: {} };

const session = {
  signal: new AbortController().signal,
  log: jest.fn(),
} as unknown as Session;

const liveCursor = (over: Partial<Record<IncrementalTypeKey, string>> = {}): LiveCursor => ({
  v: 2,
  phase: 'live',
  watermarks: Object.fromEntries(INCREMENTAL_TYPES.map((t) => [t, over[t] ?? '2026-07-01T00:00:00.000Z'])) as Record<IncrementalTypeKey, string>,
});

async function drain(gen: AsyncIterable<Batch<HubSpotCursor, HubSpotItem>>) {
  const out: Batch<HubSpotCursor, HubSpotItem>[] = [];
  for await (const b of gen) out.push(b);
  return out;
}

/** requestCount is what the budget reads — the stub must bump it like the real client. */
function stubClient(handler: (m: string, pathname: string, body?: unknown) => unknown) {
  const client = {
    requestCount: 0,
    calls: [] as Array<{ pathname: string; body?: unknown }>,
    request: async <T>(m: 'GET' | 'POST', pathname: string, body?: unknown): Promise<T> => {
      client.requestCount += 1;
      client.calls.push({ pathname, body });
      return handler(m, pathname, body) as T;
    },
    download: async () => ({ bytes: new Uint8Array(), mime: 'x' }),
  };
  return client;
}

const emptySearch = { results: [], total: 0 };
const emptyList = { results: [] };

describe('delta', () => {
  it('searches each type with GTE watermark-overlap and advances watermarks past emitted records', async () => {
    const client = stubClient((_m, pathname, body) => {
      if (pathname === '/crm/v3/objects/deals/search') {
        const b = body as { filterGroups: Array<{ filters: Array<{ propertyName: string; operator: string; value: string }> }> };
        expect(b.filterGroups[0].filters[0]).toEqual({
          propertyName: 'hs_lastmodifieddate',
          operator: 'GTE',
          value: String(Date.parse('2026-07-01T00:00:00.000Z') - OVERLAP_MS),
        });
        return { results: [{ id: 'd9', properties: { hs_lastmodifieddate: '2026-07-01T05:00:00.000Z' } }], total: 1 };
      }
      if (pathname.endsWith('/search')) return emptySearch;
      if (pathname === '/crm/v4/associations/deals/companies/batch/read')
        return { results: [{ from: { id: 'd9' }, to: [{ toObjectId: 77 }] }] };
      if (pathname.includes('/associations/')) return { results: [] };
      return emptyList; // archived sweep pages
    });

    const batches = await drain(delta(client as never, session, liveCursor(), ctx));
    const withItems = batches.filter((b) => b.items.length > 0);
    expect(withItems).toHaveLength(1);
    const item = withItems[0].items[0] as Extract<HubSpotItem, { kind: TypeKey }>;
    expect(item.kind).toBe('deals');
    expect(item.record.id).toBe('d9');
    expect(item.assoc).toEqual({ companies: ['77'] }); // only the deals→companies read returns rows
    const cur = withItems[0].cursor as Extract<HubSpotCursor, { phase: 'live' }>;
    expect(cur.watermarks.deals).toBe('2026-07-01T05:00:00.000Z');
  });

  it('visits stalest type first', async () => {
    const client = stubClient((_m, pathname) => (pathname.endsWith('/search') ? emptySearch : emptyList));
    await drain(delta(client as never, session, liveCursor({ notes: '2026-01-01T00:00:00.000Z' }), ctx));
    const searches = client.calls.filter((c) => c.pathname.endsWith('/search'));
    expect(searches[0].pathname).toBe('/crm/v3/objects/notes/search');
  });

  it('stops issuing new searches once the budget is exhausted', async () => {
    const client = stubClient((_m, pathname) =>
      pathname.endsWith('/search')
        ? {
            results: Array.from({ length: 100 }, (_, i) => ({ id: `x${i}`, properties: { hs_lastmodifieddate: '2026-07-02T00:00:00.000Z' } })),
            paging: { next: { after: '100' } },
            total: 20000,
          }
        : { results: [] },
    );
    await drain(delta(client as never, session, liveCursor(), ctx));
    expect(client.requestCount).toBeLessThanOrEqual(DELTA_REQUEST_BUDGET + 5); // in-flight page + assoc reads may finish
  });

  it('budget is unaffected by requests already made on the client before delta started', async () => {
    const client = stubClient((_m, pathname) => (pathname.endsWith('/search') ? emptySearch : emptyList));
    client.requestCount = 55; // simulate pull-time lookups (e.g. fetchRenderContext) already spent on this client
    await drain(delta(client as never, session, liveCursor(), ctx));
    const searches = client.calls.filter((c) => c.pathname.endsWith('/search'));
    expect(searches).toHaveLength(INCREMENTAL_TYPES.length); // every type still gets searched
  });

  it('re-windows instead of paging past the 10k search cap', async () => {
    let searchCalls = 0;
    const client = stubClient((_m, pathname, body) => {
      if (pathname === '/crm/v3/objects/deals/search') {
        searchCalls += 1;
        if (searchCalls === 1) {
          expect((body as { after?: string }).after).toBeUndefined();
          return {
            results: [{ id: 'a', properties: { hs_lastmodifieddate: '2026-07-03T00:00:00.000Z' } }],
            paging: { next: { after: '9900' } },
            total: 15000,
          };
        }
        // re-issued WINDOW query, not a page-after query
        expect((body as { after?: string }).after).toBeUndefined();
        const f = (body as { filterGroups: Array<{ filters: Array<{ value: string }> }> }).filterGroups[0].filters[0];
        expect(f.value).toBe(String(Date.parse('2026-07-03T00:00:00.000Z')));
        return emptySearch;
      }
      if (pathname.endsWith('/search')) return emptySearch;
      if (pathname.includes('/associations/')) return { results: [] };
      return emptyList;
    });
    await drain(delta(client as never, session, liveCursor(), ctx));
    expect(searchCalls).toBe(2);
  });

  it('reserves a floor of budget for the archived sweep under sustained churn', async () => {
    const client = stubClient((_m, pathname) => {
      if (pathname.endsWith('/search')) {
        return {
          results: Array.from({ length: 100 }, (_, i) => ({ id: `x${i}`, properties: { hs_lastmodifieddate: '2026-07-02T00:00:00.000Z' } })),
          paging: { next: { after: '100' } },
          total: 20000,
        };
      }
      if (pathname.includes('/associations/')) return { results: [] };
      return { results: [] }; // archived sweep page — empty, ends immediately
    });
    await drain(delta(client as never, session, liveCursor(), ctx));
    const sweepCalls = client.calls.filter((c) => c.pathname.includes('archived=true'));
    expect(sweepCalls.length).toBeGreaterThan(0);
  });
});

describe('delta ownership and cursor preservation', () => {
  it('drops pass-owned emails before reading associations but still advances the watermark', async () => {
    const client = stubClient((_m, pathname) => {
      if (pathname === '/crm/v3/objects/emails/search')
        return { results: [
          { id: 'out', properties: { hs_email_direction: 'EMAIL', hs_lastmodifieddate: '2026-07-02T00:00:00.000Z' } },
          { id: 'in', properties: { hs_email_direction: 'INCOMING_EMAIL', hs_lastmodifieddate: '2026-07-01T09:00:00.000Z' } },
        ] };
      if (pathname.endsWith('/search')) return emptySearch;
      return { results: [] };
    });
    const batches = await drain(delta(client as never, session, liveCursor(), ctx));
    const assocReads = client.calls.filter((c) => c.pathname.startsWith('/crm/v4/associations/emails/'));
    expect(assocReads.length).toBeGreaterThan(0);
    for (const c of assocReads) expect(c.body).toEqual({ inputs: [{ id: 'in' }] });
    const items = batches.flatMap((b) => b.items) as Array<{ record: { id: string } }>;
    expect(items.map((i) => i.record.id)).toEqual(['in']);
    const cur = batches.find((b) => b.items.length)!.cursor as LiveCursor;
    expect(cur.watermarks.emails).toBe('2026-07-02T00:00:00.000Z');
  });

  it('delta and sweep preserve dossier state on every cursor', async () => {
    const dossier = { lastCompletedAt: '2026-07-01T00:00:00.000Z', attemptedAt: null, scopes: { 'dom:x.co': 3 }, counts: { contacts: 5 } };
    const client = stubClient((_m, pathname) => {
      if (pathname === '/crm/v3/objects/notes/search')
        return { results: [{ id: 'n1', properties: { hs_lastmodifieddate: '2026-07-02T00:00:00.000Z' } }] };
      if (pathname.endsWith('/search')) return emptySearch;
      if (pathname.includes('archived=true') && pathname.includes('/objects/deals?'))
        return { results: [{ id: 'd1', properties: {} }] };
      return { results: [] };
    });
    const batches = await drain(delta(client as never, session, { ...liveCursor(), dossier }, ctx));
    expect(batches.length).toBeGreaterThan(1);
    for (const b of batches) {
      expect((b.cursor as LiveCursor).dossier).toEqual(dossier);
      expect((b.cursor as LiveCursor).v).toBe(2);
    }
  });
});

describe('batchReadAssociations', () => {
  it('reads all four object types and merges per-record', async () => {
    const client = stubClient((_m, pathname, body) => {
      expect(body).toEqual({ inputs: [{ id: 'n1' }] });
      if (pathname === '/crm/v4/associations/notes/contacts/batch/read')
        return { results: [{ from: { id: 'n1' }, to: [{ toObjectId: 501 }] }] };
      return { results: [] };
    });
    const map = await batchReadAssociations(client as never, 'notes', ['n1']);
    expect(map['n1']).toEqual({ contacts: ['501'] });
    expect(client.requestCount).toBe(4); // one per object type
  });

  it('short-circuits on empty input', async () => {
    const client = stubClient(() => ({ results: [] }));
    expect(await batchReadAssociations(client as never, 'notes', [])).toEqual({});
    expect(client.requestCount).toBe(0);
  });
});
