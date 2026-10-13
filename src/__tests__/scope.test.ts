import { assignScopes, cmpId, monthOf, type ActivityRow, type CompanyRow, type ContactRow } from '../dossier/scope';

const co = (id: string, domain: string | null): CompanyRow => ({ id, domain, name: `Co ${id}`, createdAt: '2025-01-01T00:00:00.000Z', block: `## Company ${id}` });
const ct = (id: string, email: string | null, companyIds: string[] = [], createdAt = '2026-07-03T00:00:00.000Z'): ContactRow => ({ id, email, name: `P ${id}`, createdAt, companyIds, block: `## P ${id}` });
const act = (id: string, contactIds: string[], companyIds: string[] = [], ts: string | null = '2026-08-01T00:00:00.000Z', kind: 'emails' | 'tasks' = 'emails'): ActivityRow => ({ id, kind, ts, contactIds, companyIds, block: `- ${id}` });

const byKey = (scopes: ReturnType<typeof assignScopes>) => Object.fromEntries(scopes.map((s) => [s.key, s]));

describe('cmpId / monthOf', () => {
  it('compares numeric ids numerically', () => {
    expect(cmpId('9', '10')).toBeLessThan(0);
    expect(cmpId('10', '10')).toBe(0);
  });
  it('buckets by UTC month, unknown when missing', () => {
    expect(monthOf('2026-07-03T10:00:00.000Z')).toBe('2026-07');
    expect(monthOf(null)).toBe('unknown');
    expect(monthOf('garbage')).toBe('unknown');
  });
});

describe('assignScopes', () => {
  it('joins companies and contacts on email domain', () => {
    const s = byKey(assignScopes({ companies: [co('1', 'www.Nike.com')], contacts: [ct('5', 'jane@nike.com')], activities: [] }));
    expect(Object.keys(s)).toEqual(['dom:nike.com']);
    expect(s['dom:nike.com'].domain).toBe('nike.com');
    expect(s['dom:nike.com'].companies.map((c) => c.row.id)).toEqual(['1']);
    expect(s['dom:nike.com'].contacts.map((c) => c.row.id)).toEqual(['5']);
  });

  it('public-domain contacts follow their smallest-id company scope, even a domainless one', () => {
    const s = byKey(assignScopes({
      companies: [co('20', 'acme.io'), co('3', null)],
      contacts: [ct('5', 'x@gmail.com', ['20', '3'])],
      activities: [],
    }));
    expect(s['co:3'].contacts.map((c) => c.row.id)).toEqual(['5']);
    expect(s['dom:acme.io'].contacts).toEqual([]);
  });

  it('unaffiliated public/no-email contacts go to ind:<createdate month>; unknown company ids are ignored', () => {
    const s = byKey(assignScopes({ companies: [], contacts: [ct('5', 'x@gmail.com', ['999']), ct('6', null, [], '2026-06-30T23:00:00.000Z')], activities: [] }));
    expect(s['ind:2026-07'].contacts.map((c) => c.row.id)).toEqual(['5']);
    expect(s['ind:2026-06'].contacts.map((c) => c.row.id)).toEqual(['6']);
  });

  it('activity owner = smallest-id contact in the index, else company, else orphan month', () => {
    const s = byKey(assignScopes({
      companies: [co('1', 'nike.com')],
      contacts: [ct('7', 'a@nike.com'), ct('30', 'b@other.com')],
      activities: [
        act('e1', ['30', '7']),
        act('e2', ['404'], ['1']),
        act('e3', ['404'], ['999'], '2025-02-10T00:00:00.000Z'),
      ],
    }));
    expect(s['dom:nike.com'].contacts.find((c) => c.row.id === '7')!.activities.map((a) => a.id)).toEqual(['e1']);
    expect(s['dom:nike.com'].companies[0].activities.map((a) => a.id)).toEqual(['e2']);
    expect(s['orphan:2025-02'].orphans.map((a) => a.id)).toEqual(['e3']);
    expect(s['dom:other.com'].contacts[0].activities).toEqual([]);
  });

  it('orders sections and activities deterministically and returns scopes sorted by key', () => {
    const scopes = assignScopes({
      companies: [co('10', 'b.com'), co('9', 'b.com')],
      contacts: [ct('2', 'y@b.com', [], '2026-02-01T00:00:00.000Z'), ct('1', 'x@b.com', [], '2026-03-01T00:00:00.000Z')],
      activities: [act('a2', ['2'], [], '2026-05-01T00:00:00.000Z'), act('a1', ['2'], [], '2026-04-01T00:00:00.000Z'), act('z', [], [], null)],
    });
    expect(scopes.map((s) => s.key)).toEqual(['dom:b.com', 'orphan:unknown']);
    const b = scopes[0];
    expect(b.companies.map((c) => c.row.id)).toEqual(['9', '10']);
    expect(b.contacts.map((c) => c.row.id)).toEqual(['2', '1']);
    expect(b.contacts[0].activities.map((a) => a.id)).toEqual(['a1', 'a2']);
    expect(scopes[1].month).toBe('unknown');
  });
});
