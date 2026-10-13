import { HubSpotApiError } from '../client';
import { delta } from '../delta';
import type { Batch, Session } from '@kiagent/connector-sdk';
import { INCREMENTAL_TYPES, type HubSpotCursor, type HubSpotItem, type IncrementalTypeKey, type TypeKey, type RenderContext } from '../types';

const ctx: RenderContext = { portalId: '1', owners: {}, dealStages: {}, ticketStages: {}, customProps: {} };
const session = { signal: new AbortController().signal, log: jest.fn() } as unknown as Session;

const liveCursor = (archiveSweep?: { step: IncrementalTypeKey; after: string | null }): Extract<HubSpotCursor, { phase: 'live' }> => ({
  v: 2,
  phase: 'live',
  watermarks: Object.fromEntries(INCREMENTAL_TYPES.map((t) => [t, '2026-07-01T00:00:00.000Z'])) as Record<IncrementalTypeKey, string>,
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
      deals: { results: [{ id: 'd1', properties: {} }] },
      emails: { results: [{ id: 'e1', properties: { hs_attachment_ids: 'f1;f2' } }] },
    });
    const batches = await drain(delta(client as never, session, liveCursor(), ctx));
    const dels = batches.flatMap((b) => b.deletions ?? []);
    expect(dels).toContainEqual({ externalId: 'd1', type: 'hubspot.deal' });
    expect(client.calls.some((c) => /objects\/(contacts|companies|tasks)\?/.test(c))).toBe(false);
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
    // First notes page carries a pager cursor; the resumed page is empty —
    // a stub that ALWAYS returns the pager would loop the sweep forever.
    let notesCalls = 0;
    const client = stubClient({});
    const base = client.request.bind(client);
    client.request = (async <T>(m: 'GET' | 'POST', pathname: string): Promise<T> => {
      if (pathname.includes('/objects/notes?') && pathname.includes('archived=true')) {
        client.requestCount += 1;
        client.calls.push(pathname);
        notesCalls += 1;
        return (notesCalls === 1
          ? { results: [{ id: 'n1', properties: {} }], paging: { next: { after: 'T2' } } }
          : { results: [] }) as T;
      }
      return base(m, pathname) as Promise<T>;
    }) as typeof client.request;
    // start mid-rotation at notes
    const batches = await drain(delta(client as never, session, liveCursor({ step: 'notes', after: null }), ctx));
    const sweepCalls = client.calls.filter((c) => c.includes('archived=true'));
    expect(sweepCalls[0]).toContain('/crm/v3/objects/notes?');
    // n1 deleted, then the pager cursor was carried into the batch cursor at least once
    const carried = batches.some((b) => {
      const c = b.cursor as Extract<HubSpotCursor, { phase: 'live' }>;
      return c.archiveSweep?.step === 'notes' && c.archiveSweep.after === 'T2';
    });
    expect(carried).toBe(true);
  });

  /** A client whose archived listing of `failing` throws `err`. */
  function failingClient(failing: TypeKey, err: Error, archivedByType: Partial<Record<TypeKey, unknown>> = {}) {
    const client = stubClient(archivedByType);
    const base = client.request.bind(client);
    client.request = (async <T>(m: 'GET' | 'POST', pathname: string): Promise<T> => {
      if (pathname.includes(`/objects/${failing}?`) && pathname.includes('archived=true')) {
        client.requestCount += 1;
        client.calls.push(pathname);
        throw err;
      }
      return base(m, pathname) as Promise<T>;
    }) as typeof client.request;
    return client;
  }
  const unsupported = () =>
    new HubSpotApiError(
      400,
      'VALIDATION_ERROR',
      'Paging through deleted objects is not yet supported for object type 0-47 (MEETING_EVENT)',
    );
  const sweepCursor = (b: Batch<HubSpotCursor, HubSpotItem>) =>
    (b.cursor as Extract<HubSpotCursor, { phase: 'live' }>).archiveSweep;

  it('skips a type HubSpot cannot list archived, sweeps the rest and completes the pass', async () => {
    const client = failingClient('meetings', unsupported(), {
      emails: { results: [{ id: 'e1', properties: {} }] },
    });
    const batches = await drain(delta(client as never, session, liveCursor({ step: 'meetings', after: null }), ctx));
    const sweepCalls = client.calls.filter((c) => c.includes('archived=true'));
    expect(sweepCalls.filter((c) => c.includes('/objects/meetings?'))).toHaveLength(1);
    expect(sweepCalls.some((c) => c.includes('/objects/emails?'))).toBe(true);
    const dels = batches.flatMap((b) => b.deletions ?? []);
    expect(dels).toContainEqual({ externalId: 'e1', type: 'hubspot.email' });
    // The skip itself persists the next type, so a budget cut right after
    // it never resumes on the unsupported type again.
    expect(batches.map(sweepCursor)).toContainEqual({ step: 'emails', after: null });
    expect(sweepCursor(batches[batches.length - 1])).toBeUndefined();
  });

  it('ends the pass when the unsupported type is the last one swept', async () => {
    const last = INCREMENTAL_TYPES[INCREMENTAL_TYPES.length - 1];
    const client = failingClient(last, unsupported());
    const batches = await drain(delta(client as never, session, liveCursor({ step: last, after: null }), ctx));
    expect(sweepCursor(batches[batches.length - 1])).toBeUndefined();
  });

  it('drops the pager when skipping mid-type, so the next type starts from its first page', async () => {
    const client = failingClient('meetings', unsupported());
    await drain(delta(client as never, session, liveCursor({ step: 'meetings', after: 'M9' }), ctx));
    const emailsCall = client.calls.find((c) => c.includes('/objects/emails?') && c.includes('archived=true'));
    expect(emailsCall).toBeDefined();
    expect(emailsCall).not.toContain('after=');
  });

  it('still fails the sync on any other validation error', async () => {
    const client = failingClient(
      'meetings',
      new HubSpotApiError(400, 'VALIDATION_ERROR', 'Property "hs_attachment_ids" does not exist'),
    );
    await expect(drain(delta(client as never, session, liveCursor({ step: 'meetings', after: null }), ctx))).rejects.toThrow(
      'does not exist',
    );
  });

  it('still fails the sync on any other error', async () => {
    const client = failingClient('meetings', new HubSpotApiError(500, 'INTERNAL_ERROR', 'boom'));
    await expect(drain(delta(client as never, session, liveCursor({ step: 'meetings', after: null }), ctx))).rejects.toThrow(
      'INTERNAL_ERROR',
    );
  });
});
