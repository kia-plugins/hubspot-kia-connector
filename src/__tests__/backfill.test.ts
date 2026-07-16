import { assocFromRecord, backfill } from '../backfill';
import type { Batch, Session } from '../kiagent-contracts';
import type { HubSpotCursor, HubSpotItem, RenderContext } from '../types';
import { ALL_TYPES } from '../types';

const ctx: RenderContext = { portalId: '1', owners: {}, dealStages: {}, ticketStages: {}, customProps: {} };

const mkSession = () => {
  const ac = new AbortController();
  return {
    session: { signal: ac.signal, log: jest.fn(), credentials: async () => ({ password: 'pat-x' }) } as unknown as Session,
    ac,
  };
};

/** Every type returns one single-record page except contacts (two pages). */
function stubClient() {
  const paths: string[] = [];
  const client = {
    requestCount: 0,
    paths,
    request: async <T>(_m: string, pathname: string): Promise<T> => {
      paths.push(pathname);
      const type = pathname.split('?')[0].split('/')[4];
      if (type === 'contacts' && !pathname.includes('after=')) {
        return { results: [{ id: 'c1', properties: {}, associations: { companies: { results: [{ id: '77', type: 'x' }] } } }], paging: { next: { after: 'P2' } } } as T;
      }
      if (type === 'contacts') return { results: [{ id: 'c2', properties: {} }] } as T;
      return { results: [{ id: `${type}-1`, properties: {} }] } as T;
    },
    download: async () => ({ bytes: new Uint8Array(), mime: 'x' }),
  };
  return client;
}

async function drain(gen: AsyncIterable<Batch<HubSpotCursor, HubSpotItem>>) {
  const batches: Batch<HubSpotCursor, HubSpotItem>[] = [];
  for await (const b of gen) batches.push(b);
  return batches;
}

describe('backfill', () => {
  it('walks all types in order, pages within a type, ends live', async () => {
    const { session } = mkSession();
    const batches = await drain(backfill(stubClient() as never, session, null, ctx));

    // 9 types, contacts contributes 2 pages → 10 backfill batches + 1 final live
    expect(batches).toHaveLength(11);
    expect(batches[0].phase).toBe('backfill');
    expect((batches[0].items[0] as { record: { id: string } }).record.id).toBe('companies-1');

    // contacts page 1 carries its paging cursor
    const contactsPage1 = batches[1];
    expect(contactsPage1.cursor).toMatchObject({ phase: 'backfill', step: 'contacts', after: 'P2' });
    // association came through from the list endpoint
    expect((contactsPage1.items[0] as { assoc: unknown }).assoc).toEqual({ companies: ['77'] });

    const last = batches[batches.length - 1];
    expect(last.phase).toBe('live');
    expect(last.items).toHaveLength(0);
    const lastCursor = last.cursor as Extract<HubSpotCursor, { phase: 'live' }>;
    for (const t of ALL_TYPES) expect(typeof lastCursor.watermarks[t]).toBe('string');
  });

  it('resumes mid-type from a backfill cursor', async () => {
    const { session } = mkSession();
    const client = stubClient();
    const cursor: Extract<HubSpotCursor, { phase: 'backfill' }> = {
      phase: 'backfill',
      step: 'contacts',
      after: 'P2',
      watermarks: { companies: '2026-01-01T00:00:00.000Z' },
      backfillStartedAt: '2026-01-01T00:00:00.000Z',
    };
    const batches = await drain(backfill(client as never, session, cursor, ctx));
    // contacts page 2, then the 7 remaining types, then live
    expect(client.paths[0]).toContain('after=P2');
    expect(batches[batches.length - 1].phase).toBe('live');
    const wm = (batches[batches.length - 1].cursor as Extract<HubSpotCursor, { phase: 'live' }>).watermarks;
    expect(wm.companies).toBe('2026-01-01T00:00:00.000Z'); // preserved, not restamped
  });

  it('checkpoints straight to live when the last type (emails) finishes its final page', async () => {
    const { session } = mkSession();
    const client = stubClient();
    const cursor: Extract<HubSpotCursor, { phase: 'backfill' }> = {
      phase: 'backfill',
      step: 'emails',
      after: null,
      watermarks: {
        companies: '2026-01-01T00:00:00.000Z',
        contacts: '2026-01-01T00:00:00.000Z',
        deals: '2026-01-01T00:00:00.000Z',
        tickets: '2026-01-01T00:00:00.000Z',
        notes: '2026-01-01T00:00:00.000Z',
        calls: '2026-01-01T00:00:00.000Z',
        meetings: '2026-01-01T00:00:00.000Z',
        tasks: '2026-01-01T00:00:00.000Z',
      },
      backfillStartedAt: '2026-01-01T00:00:00.000Z',
    };
    const batches = await drain(backfill(client as never, session, cursor, ctx));
    // one batch carrying the emails page, then the terminal empty live batch
    expect(batches).toHaveLength(2);
    const emailsBatch = batches[0];
    expect((emailsBatch.items[0] as { kind: string }).kind).toBe('emails');
    // must be an exact-resume live cursor, NOT a backfill cursor pointing back at emails
    expect(emailsBatch.cursor.phase).toBe('live');
    const wm = (emailsBatch.cursor as Extract<HubSpotCursor, { phase: 'live' }>).watermarks;
    for (const t of ALL_TYPES) expect(typeof wm[t]).toBe('string');
  });

  it('stops yielding on abort', async () => {
    const { session, ac } = mkSession();
    const gen = backfill(stubClient() as never, session, null, ctx);
    const first = await gen[Symbol.asyncIterator]().next();
    expect(first.done).toBe(false);
    ac.abort();
    const rest = await drain(gen as AsyncIterable<Batch<HubSpotCursor, HubSpotItem>>);
    expect(rest).toHaveLength(0);
  });

  it('requests attachments for engagement records that have them', async () => {
    const { session } = mkSession();
    const client = stubClient();
    // make notes return an attachment id and serve the files endpoints
    const base = client.request.bind(client);
    client.request = (async <T>(m: 'GET' | 'POST', pathname: string): Promise<T> => {
      if (pathname.startsWith('/crm/v3/objects/notes')) {
        return { results: [{ id: 'n1', properties: { hs_attachment_ids: 'f1' } }] } as T;
      }
      if (pathname === '/files/v3/files/f1') return { id: 'f1', name: 'a', extension: 'txt', size: 3 } as T;
      if (pathname === '/files/v3/files/f1/signed-url') return { url: 'https://s/f1' } as T;
      return base(m, pathname) as Promise<T>;
    }) as typeof client.request;
    client.download = async () => ({ bytes: new Uint8Array([1]), mime: 'text/plain' });

    const batches = await drain(backfill(client as never, session, null, ctx));
    const noteBatch = batches.find((b) => b.items.some((i) => (i as { kind: string }).kind === 'notes'))!;
    const kinds = noteBatch.items.map((i) => (i as { kind: string }).kind);
    expect(kinds).toEqual(['notes', 'file']); // file doc rides the SAME batch as its parent
  });
});

describe('assocFromRecord', () => {
  it('extracts and dedupes association ids per type', () => {
    expect(
      assocFromRecord({
        id: '1',
        properties: {},
        associations: {
          companies: { results: [{ id: '7', type: 'a' }, { id: '7', type: 'b' }] },
          deals: { results: [{ id: '8', type: 'c' }] },
        },
      }),
    ).toEqual({ companies: ['7'], deals: ['8'] });
  });
});
