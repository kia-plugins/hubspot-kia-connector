import type { Batch, Session } from '@kiagent/connector-sdk';
import { dossierPass, DOSSIER_EVERY_MS, DOSSIER_RETRY_MS, emptyDossier, isPassDue } from '../dossier/pass';
import { partId } from '../dossier/layout';
import { ctx } from '../testing/fixtures';
import { INCREMENTAL_TYPES, type HubSpotCursor, type HubSpotItem, type LiveCursor } from '../types';

const NOW = Date.parse('2026-10-13T12:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();
const mkSession = () => {
  const ac = new AbortController();
  return { ac, session: { signal: ac.signal, log: jest.fn() } as unknown as Session };
};
const live = (dossier?: LiveCursor['dossier']): LiveCursor => ({
  v: 2,
  phase: 'live',
  watermarks: Object.fromEntries(INCREMENTAL_TYPES.map((t) => [t, '2026-10-01T00:00:00.000Z'])) as LiveCursor['watermarks'],
  ...(dossier ? { dossier } : {}),
});

type Rec = { id: string; properties: Record<string, string | null>; associations?: Record<string, { results: Array<{ id: string; type: string }> }> };
/** One page per type; `onList` sees every list path. */
function client(data: Partial<Record<'contacts' | 'companies' | 'tasks' | 'emails', Rec[]>>, onList?: (path: string) => void) {
  return {
    request: async <T>(_m: string, path: string): Promise<T> => {
      onList?.(path);
      const type = path.split('?')[0].split('/')[4] as keyof typeof data;
      return { results: data[type] ?? [] } as T;
    },
  };
}
const contact = (id: string, email: string): Rec => ({ id, properties: { email, firstname: `P${id}`, createdate: '2026-07-01T00:00:00.000Z' } });
const outbound = (id: string, contactId: string, attach = ''): Rec => ({
  id, properties: { hs_email_direction: 'EMAIL', hs_attachment_ids: attach, hs_timestamp: '2026-08-01T00:00:00.000Z', hs_email_text: 'x'.repeat(3000) },
  associations: { contacts: { results: [{ id: contactId, type: 'x' }] } },
});

async function drain(gen: AsyncIterable<Batch<HubSpotCursor, HubSpotItem>>) {
  const out: Batch<HubSpotCursor, HubSpotItem>[] = [];
  for await (const b of gen) out.push(b);
  return out;
}
const docsOf = (bs: Batch<HubSpotCursor, HubSpotItem>[]) =>
  bs.flatMap((b) => b.items.flatMap((i) => (i.kind === 'dossier' ? i.docs : [])));
const lastDossier = (bs: Batch<HubSpotCursor, HubSpotItem>[]) => (bs[bs.length - 1].cursor as LiveCursor).dossier!;

describe('isPassDue', () => {
  it('runs when never run, waits DOSSIER_EVERY after success and DOSSIER_RETRY after an attempt', () => {
    expect(isPassDue(undefined, NOW)).toBe(true);
    expect(isPassDue({ ...emptyDossier(), lastCompletedAt: iso(NOW - DOSSIER_EVERY_MS + 1), attemptedAt: iso(NOW - DOSSIER_EVERY_MS + 1) }, NOW)).toBe(false);
    expect(isPassDue({ ...emptyDossier(), lastCompletedAt: iso(NOW - DOSSIER_EVERY_MS), attemptedAt: iso(NOW - DOSSIER_EVERY_MS) }, NOW)).toBe(true);
    expect(isPassDue({ ...emptyDossier(), lastCompletedAt: null, attemptedAt: iso(NOW - DOSSIER_RETRY_MS + 1) }, NOW)).toBe(false);
  });
});

describe('dossierPass', () => {
  it('commits attemptedAt first, then dossier chunks, then a final batch completing the pass', async () => {
    const { session } = mkSession();
    const listed: string[] = [];
    const bs = await drain(dossierPass(client({ contacts: [contact('5', 'a@nike.com')], emails: [outbound('e1', '5')] }, (p) => listed.push(p)), session, live(), ctx, NOW));
    expect(bs[0].items).toEqual([]);
    expect((bs[0].cursor as LiveCursor).dossier!.attemptedAt).toBe(iso(NOW));
    expect((bs[0].cursor as LiveCursor).dossier!.lastCompletedAt).toBeNull();
    expect(listed.some((p) => p.startsWith('/crm/v3/objects/contacts?') && p.includes('associations=companies'))).toBe(true);
    expect(listed.some((p) => p.startsWith('/crm/v3/objects/emails?') && p.includes('associations=contacts%2Ccompanies'))).toBe(true);
    const docs = docsOf(bs);
    expect(docs.map((d) => d.externalId)).toEqual([partId('dom:nike.com', 0)]);
    expect(docs[0].markdown).toContain('Email sent');
    const d = lastDossier(bs);
    expect(d).toMatchObject({ lastCompletedAt: iso(NOW), attemptedAt: iso(NOW), scopes: { 'dom:nike.com': 1 }, counts: { contacts: 1, companies: 0, tasks: 0, emails: 1 } });
    for (const b of bs) expect((b.cursor as LiveCursor).watermarks).toEqual(live().watermarks);
  });

  it('skips incoming and attached emails, and deletes the standalone ref of every folded email', async () => {
    const { session } = mkSession();
    const incoming: Rec = { id: 'in', properties: { hs_email_direction: 'INCOMING_EMAIL' }, associations: { contacts: { results: [{ id: '5', type: 'x' }] } } };
    const bs = await drain(dossierPass(client({ contacts: [contact('5', 'a@nike.com')], emails: [outbound('e1', '5'), outbound('e2', '5', '77'), incoming] }), session, live(), ctx, NOW));
    const md = docsOf(bs)[0].markdown!;
    expect(docsOf(bs)[0].metadata.engagementIds).toEqual(['e1']);
    expect(md).not.toContain('e2');
    const dels = bs.flatMap((b) => b.deletions ?? []);
    expect(dels).toContainEqual({ externalId: 'e1', type: 'hubspot.email' });
    expect(dels).not.toContainEqual({ externalId: 'e2', type: 'hubspot.email' });
    expect(dels).not.toContainEqual({ externalId: 'in', type: 'hubspot.email' });
  });

  it('final batch deletes trailing parts of shrunk scopes and every part of vanished scopes', async () => {
    const { session } = mkSession();
    const prev = { ...emptyDossier(), lastCompletedAt: iso(NOW - DOSSIER_EVERY_MS), attemptedAt: iso(NOW - DOSSIER_EVERY_MS), scopes: { 'dom:nike.com': 3, 'dom:gone.com': 2 }, counts: { contacts: 1, emails: 1 } };
    const bs = await drain(dossierPass(client({ contacts: [contact('5', 'a@nike.com')], emails: [outbound('e1', '5')] }), session, live(prev), ctx, NOW));
    const final = bs[bs.length - 1];
    expect(final.items).toEqual([]);
    expect(final.deletions).toEqual(expect.arrayContaining([
      { externalId: partId('dom:nike.com', 1), type: 'hubspot.dossier' },
      { externalId: partId('dom:nike.com', 2), type: 'hubspot.dossier' },
      { externalId: partId('dom:gone.com', 0), type: 'hubspot.dossier' },
      { externalId: partId('dom:gone.com', 1), type: 'hubspot.dossier' },
    ]));
    expect(final.deletions).not.toContainEqual({ externalId: partId('dom:nike.com', 0), type: 'hubspot.dossier' });
    expect(lastDossier(bs).scopes).toEqual({ 'dom:nike.com': 1 });
  });

  it('high-water map covers parts of an interrupted multi-chunk scope', async () => {
    const { session, ac } = mkSession();
    const contacts = Array.from({ length: 40 }, (_, i) => contact(String(100 + i), `p${i}@nike.com`));
    const emails = contacts.map((c, i) => outbound(`e${i}`, c.id));
    const gen = dossierPass(client({ contacts, emails }), session, live(), ctx, NOW, 20_000);
    const seen: Batch<HubSpotCursor, HubSpotItem>[] = [];
    for await (const b of gen) {
      seen.push(b);
      if (seen.length === 3) ac.abort(); // attemptedAt + two chunks committed, then "sleep"
    }
    const committedParts = docsOf(seen).filter((d) => d.externalId.startsWith('hubspot-dossier:dom:nike.com:')).length;
    expect(committedParts).toBeGreaterThan(1);
    const d = (seen[seen.length - 1].cursor as LiveCursor).dossier!;
    expect(d.scopes['dom:nike.com']).toBeGreaterThanOrEqual(committedParts);
    expect(d.lastCompletedAt).toBeNull();
    for (const b of seen) for (const i of b.items) if (i.kind === 'dossier') expect(i.docs.reduce((n, x) => n + x.markdown!.length, 0)).toBeLessThanOrEqual(20_000 + 8_000);
  });

  it('shrink guard skips deletions and lastCompletedAt when a listing collapses', async () => {
    const { session } = mkSession();
    const prev = { ...emptyDossier(), lastCompletedAt: iso(NOW - DOSSIER_EVERY_MS), attemptedAt: iso(NOW - DOSSIER_EVERY_MS), scopes: { 'dom:gone.com': 2 }, counts: { contacts: 100 } };
    const bs = await drain(dossierPass(client({ contacts: [contact('5', 'a@nike.com')] }), session, live(prev), ctx, NOW));
    expect(docsOf(bs)).toEqual([]); // nothing built from a truncated index is written
    expect(bs.flatMap((b) => b.deletions ?? []).filter((r) => r.type === 'hubspot.dossier')).toEqual([]);
    const d = lastDossier(bs);
    expect(d.lastCompletedAt).toBe(prev.lastCompletedAt);
    expect(d.counts).toEqual(prev.counts);
    expect(d.scopes['dom:gone.com']).toBe(2);
    expect((session.log as jest.Mock).mock.calls.some(([lvl]) => lvl === 'warn')).toBe(true);
  });

  it('pages each listing with `after` until paging.next is absent', async () => {
    const { session } = mkSession();
    const paths: string[] = [];
    const c = {
      request: async <T>(_m: string, path: string): Promise<T> => {
        paths.push(path);
        if (path.startsWith('/crm/v3/objects/contacts?') && !path.includes('after='))
          return { results: [contact('1', 'a@x.com')], paging: { next: { after: 'C2' } } } as T;
        if (path.startsWith('/crm/v3/objects/contacts?')) return { results: [contact('2', 'b@x.com')] } as T;
        return { results: [] } as T;
      },
    };
    const bs = await drain(dossierPass(c, session, live(), ctx, NOW));
    expect(paths.filter((p) => p.startsWith('/crm/v3/objects/contacts?'))).toHaveLength(2);
    expect(lastDossier(bs).counts.contacts).toBe(2);
  });

  it('deletes each folded email standalone ref in the same batch that writes its part', async () => {
    const { session } = mkSession();
    const contacts = Array.from({ length: 40 }, (_, i) => contact(String(100 + i), `p${i}@nike.com`));
    const emails = contacts.map((c, i) => outbound(`e${i}`, c.id));
    const bs = await drain(dossierPass(client({ contacts, emails }), session, live(), ctx, NOW, 20_000));
    for (const b of bs) {
      const written = b.items.flatMap((i) => (i.kind === 'dossier' ? i.docs : [])).flatMap((d) => d.metadata.engagementIds as string[]);
      const deleted = (b.deletions ?? []).filter((r) => r.type === 'hubspot.email').map((r) => r.externalId);
      expect(deleted.sort()).toEqual([...written].sort());
    }
  });

  it('bounds every chunk by UTF-8 bytes, not characters', async () => {
    const { session } = mkSession();
    const contacts = Array.from({ length: 40 }, (_, i) => contact(String(100 + i), `p${i}@nike.com`));
    const emails = contacts.map((c, i) => ({ ...outbound(`e${i}`, c.id), properties: { ...outbound(`e${i}`, c.id).properties, hs_email_text: '漢'.repeat(3000) } }));
    const bs = await drain(dossierPass(client({ contacts, emails }), session, live(), ctx, NOW, 20_000));
    const chunks = bs.filter((b) => b.items.length);
    expect(chunks.length).toBeGreaterThan(1);
    for (const b of chunks) {
      const docs = b.items.flatMap((i) => (i.kind === 'dossier' ? i.docs : []));
      const bytes = docs.reduce((n, d) => n + Buffer.byteLength(d.markdown ?? ''), 0);
      expect(bytes).toBeLessThanOrEqual(20_000);
    }
  });
});
