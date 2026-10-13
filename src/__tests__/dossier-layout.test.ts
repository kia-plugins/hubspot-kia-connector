import { activityRow, BLOCK_MAX, capText, companyRow, contactRow, FOLD_BODY_MAX, TRUNC_MARK } from '../dossier/blocks';
import { layoutScope, PART_MAX_CHARS, partId } from '../dossier/layout';
import { assignScopes } from '../dossier/scope';
import { ctx } from '../testing/fixtures';

const rec = (id: string, properties: Record<string, string | null>, associations?: Record<string, { results: Array<{ id: string; type: string }> }>) =>
  ({ id, properties, associations });

describe('blocks', () => {
  it('capText keeps short text and cuts long text with the marker', () => {
    expect(capText('abc', 10)).toBe('abc');
    const out = capText('x'.repeat(100), 50);
    expect(out.length).toBeLessThanOrEqual(50);
    expect(out.endsWith(TRUNC_MARK)).toBe(true);
  });

  it('renders a contact section with a linked heading and its company associations', () => {
    const row = contactRow(rec('5', { firstname: 'Jane', lastname: 'Doe', email: 'jane@nike.com', createdate: '2026-07-03T00:00:00.000Z' }, { companies: { results: [{ id: '1', type: 'x' }] } }), ctx);
    expect(row).toMatchObject({ id: '5', email: 'jane@nike.com', name: 'Jane Doe', companyIds: ['1'], createdAt: '2026-07-03T00:00:00.000Z' });
    expect(row.block.split('\n')[0]).toBe('## Jane Doe · [open](https://app.hubspot.com/contacts/123/record/0-1/5)');
    expect(row.block).toContain('**Email:** jane@nike.com');
  });

  it('renders a company section, capping a huge description', () => {
    const row = companyRow(rec('1', { name: 'Nike', domain: 'nike.com', description: 'd'.repeat(20_000) }), ctx);
    expect(row).toMatchObject({ id: '1', domain: 'nike.com', name: 'Nike' });
    expect(row.block.startsWith('## Company: Nike · [open](https://app.hubspot.com/contacts/123/record/0-2/1)')).toBe(true);
    expect(row.block.length).toBeLessThanOrEqual(BLOCK_MAX);
  });

  it('renders a folded email entry with sender, subject and a body capped at FOLD_BODY_MAX', () => {
    const row = activityRow('emails', rec('e1', {
      hs_timestamp: '2025-07-09T10:00:00.000Z', hs_email_subject: 'Re: hello',
      hs_email_headers: JSON.stringify({ from: { email: 'daniel@grips.co' }, to: [{ email: 'jane@nike.com' }] }),
      hs_email_text: 'b'.repeat(10_000),
    }, { contacts: { results: [{ id: '5', type: 'x' }] } }), ctx);
    expect(row).toMatchObject({ id: 'e1', kind: 'emails', ts: '2025-07-09T10:00:00.000Z', contactIds: ['5'], companyIds: [] });
    expect(row.block.split('\n')[0]).toBe('- 2025-07-09 · Email sent (daniel@grips.co) · "Re: hello"');
    expect(row.block).toContain(TRUNC_MARK);
    expect(row.block.length).toBeLessThan(FOLD_BODY_MAX + 300);
  });

  it('renders a task entry', () => {
    const row = activityRow('tasks', rec('t1', { hs_timestamp: '2025-07-12T00:00:00.000Z', hs_task_subject: 'LinkedIn: Visit Profile', hs_task_status: 'COMPLETED' }), ctx);
    expect(row.block).toBe('- 2025-07-12 · Task · LinkedIn: Visit Profile · COMPLETED');
  });
});

describe('layoutScope', () => {
  const index = (contacts: number, bodyChars: number) => ({
    companies: [companyRow(rec('1', { name: 'Nike', domain: 'nike.com', createdate: '2020-01-01T00:00:00.000Z' }), ctx)],
    contacts: Array.from({ length: contacts }, (_, i) =>
      contactRow(rec(String(100 + i), { firstname: `P${i}`, email: `p${i}@nike.com`, createdate: `2026-07-0${1 + (i % 9)}T00:00:00.000Z` }), ctx)),
    // two sends per contact, so a contact's activity can spill into the next part
    activities: Array.from({ length: contacts * 2 }, (_, i) =>
      activityRow('emails', rec(`e${i}`, { hs_timestamp: '2026-08-01T00:00:00.000Z', hs_email_subject: 's', hs_email_text: 'w'.repeat(bodyChars) },
        { contacts: { results: [{ id: String(100 + (i % contacts)), type: 'x' }] } }), ctx)),
  });

  it('one small scope → one part titled "<company> (<domain>)" with a stable id and no counts', () => {
    const [scope] = assignScopes(index(2, 10));
    const parts = layoutScope(scope, ctx.portalId);
    expect(parts).toHaveLength(1);
    expect(parts[0].externalId).toBe(partId('dom:nike.com', 0));
    expect(parts[0].externalId).toBe('hubspot-dossier:dom:nike.com:0');
    expect(parts[0].type).toBe('hubspot.dossier');
    expect(parts[0].title).toBe('Nike (nike.com)');
    expect(parts[0].url).toBe('https://app.hubspot.com/contacts/123/record/0-2/1');
    expect(parts[0].parent).toBeUndefined();
    expect(parts[0].metadata).toMatchObject({ scope: 'dom:nike.com', domain: 'nike.com', part: 0, companyIds: ['1'] });
    expect(parts[0].metadata.participants).toEqual(expect.arrayContaining(['p0@nike.com', 'p1@nike.com']));
    expect(parts[0].metadata.engagementIds).toEqual(expect.arrayContaining(['e0', 'e1']));
    expect(parts[0].createdAt).toBe('2026-08-01T00:00:00.000Z');
    expect(JSON.stringify(parts[0])).not.toMatch(/part \d+\/\d+|"parts"/);
  });

  it('no part exceeds PART_MAX_CHARS even with oversized blocks; continuation headers repeat', () => {
    const [scope] = assignScopes(index(30, 9_000));
    const parts = layoutScope(scope, ctx.portalId);
    expect(parts.length).toBeGreaterThan(5);
    for (const p of parts) expect(p.markdown!.length).toBeLessThanOrEqual(PART_MAX_CHARS);
    expect(parts[1].title).toBe('Nike (nike.com) — part 2');
    expect(parts.some((p) => /\(cont\.\)/.test(p.markdown!))).toBe(true);
    expect(parts.map((p) => p.externalId)).toEqual(parts.map((_, i) => partId('dom:nike.com', i)));
  });

  it('adding a contact at the end leaves earlier parts byte-identical', () => {
    const a = layoutScope(assignScopes(index(30, 3_000))[0], ctx.portalId);
    const bigger = index(30, 3_000);
    bigger.contacts.push(contactRow(rec('999', { firstname: 'Late', email: 'late@nike.com', createdate: '2026-09-30T00:00:00.000Z' }), ctx));
    const b = layoutScope(assignScopes(bigger)[0], ctx.portalId);
    expect(b.slice(0, a.length - 1)).toEqual(a.slice(0, a.length - 1));
  });

  it('titles individuals and orphan buckets', () => {
    const scopes = assignScopes({
      companies: [],
      contacts: [contactRow(rec('5', { firstname: 'X', email: 'x@gmail.com', createdate: '2026-07-03T00:00:00.000Z' }), ctx)],
      activities: [activityRow('tasks', rec('t1', { hs_timestamp: '2025-02-01T00:00:00.000Z', hs_task_subject: 'Call' }), ctx)],
    });
    const titles = scopes.map((s) => layoutScope(s, ctx.portalId)[0].title);
    expect(titles).toEqual(['Individuals — 2026-07', 'Unassigned activity — 2025-02']);
  });
});
