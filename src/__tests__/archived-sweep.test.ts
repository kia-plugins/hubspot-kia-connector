import { delta } from '../delta';
import type { Batch, Session } from '../kiagent-contracts';
import { ALL_TYPES, type HubSpotCursor, type HubSpotItem, type TypeKey, type RenderContext } from '../types';

const ctx: RenderContext = { portalId: '1', owners: {}, dealStages: {}, ticketStages: {}, customProps: {} };
const session = { signal: new AbortController().signal, log: jest.fn() } as unknown as Session;

const liveCursor = (archiveSweep?: { step: TypeKey; after: string | null }): Extract<HubSpotCursor, { phase: 'live' }> => ({
  phase: 'live',
  watermarks: Object.fromEntries(ALL_TYPES.map((t) => [t, '2026-07-01T00:00:00.000Z'])) as Record<TypeKey, string>,
  archiveSweep,
});

async function drain(gen: AsyncIterable<Batch<HubSpotCursor, HubSpotItem>>) {
  const out: Batch<HubSpotCursor, HubSpotItem>[] = [];
  for await (const b of gen) out.push(b);
  return out;
}

function stubClient(archivedByType: Partial<Record<TypeKey, unknown>>) {
  const client = {
    requestCount: 0,
    calls: [] as string[],
    request: async <T>(_m: string, pathname: string): Promise<T> => {
      client.requestCount += 1;
      client.calls.push(pathname);
      if (pathname.endsWith('/search')) return { results: [] } as T;
      if (pathname.includes('archived=true')) {
        const type = pathname.split('?')[0].split('/')[4] as TypeKey;
        return (archivedByType[type] ?? { results: [] }) as T;
      }
      return { results: [] } as T;
    },
    download: async () => ({ bytes: new Uint8Array(), mime: 'x' }),
  };
  return client;
}

describe('archivedSweep', () => {
  it('emits deletions for archived records, including engagement attachment file docs', async () => {
    const client = stubClient({
      contacts: { results: [{ id: 'c1', properties: {} }] },
      emails: { results: [{ id: 'e1', properties: { hs_attachment_ids: 'f1;f2' } }] },
    });
    const batches = await drain(delta(client as never, session, liveCursor(), ctx));
    const dels = batches.flatMap((b) => b.deletions ?? []);
    expect(dels).toContainEqual({ externalId: 'c1', type: 'hubspot.contact' });
    expect(dels).toContainEqual({ externalId: 'e1', type: 'hubspot.email' });
    expect(dels).toContainEqual({ externalId: 'f1', type: 'file' });
    expect(dels).toContainEqual({ externalId: 'f2', type: 'file' });
  });

  it('clears archiveSweep after a full pass', async () => {
    const client = stubClient({});
    const batches = await drain(delta(client as never, session, liveCursor(), ctx));
    const last = batches[batches.length - 1];
    expect((last.cursor as Extract<HubSpotCursor, { phase: 'live' }>).archiveSweep).toBeUndefined();
  });

  it('resumes from a stored sweep position and carries the pager cursor', async () => {
    // First tasks page carries a pager cursor; the resumed page is empty —
    // a stub that ALWAYS returns the pager would loop the sweep forever.
    let tasksCalls = 0;
    const client = stubClient({});
    const base = client.request.bind(client);
    client.request = (async <T>(m: 'GET' | 'POST', pathname: string): Promise<T> => {
      if (pathname.includes('/objects/tasks?') && pathname.includes('archived=true')) {
        client.requestCount += 1;
        client.calls.push(pathname);
        tasksCalls += 1;
        return (tasksCalls === 1
          ? { results: [{ id: 't1', properties: {} }], paging: { next: { after: 'T2' } } }
          : { results: [] }) as T;
      }
      return base(m, pathname) as Promise<T>;
    }) as typeof client.request;
    // start mid-rotation at tasks
    const batches = await drain(delta(client as never, session, liveCursor({ step: 'tasks', after: null }), ctx));
    const sweepCalls = client.calls.filter((c) => c.includes('archived=true'));
    expect(sweepCalls[0]).toContain('/crm/v3/objects/tasks?');
    // t1 deleted, then the pager cursor was carried into the batch cursor at least once
    const carried = batches.some((b) => {
      const c = b.cursor as Extract<HubSpotCursor, { phase: 'live' }>;
      return c.archiveSweep?.step === 'tasks' && c.archiveSweep.after === 'T2';
    });
    expect(carried).toBe(true);
  });
});
