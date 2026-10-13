import { emailDomain, isPublicDomain, normalizeDomain } from './domains';

export interface CompanyRow { id: string; domain: string | null; name: string; createdAt: string | null; block: string }
export interface ContactRow { id: string; email: string | null; name: string; createdAt: string | null; companyIds: string[]; block: string }
export interface ActivityRow { id: string; kind: 'emails' | 'tasks'; ts: string | null; contactIds: string[]; companyIds: string[]; block: string }
export interface DossierIndex { companies: CompanyRow[]; contacts: ContactRow[]; activities: ActivityRow[] }
export interface Section<R> { row: R; activities: ActivityRow[] }
export interface Scope {
  key: string;
  domain: string | null;
  month: string | null;
  companies: Section<CompanyRow>[];
  contacts: Section<ContactRow>[];
  orphans: ActivityRow[];
}

/** HubSpot ids are decimal strings: shorter is smaller, then lexical. */
export function cmpId(a: string, b: string): number {
  return a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);
}

export function monthOf(ts: string | null): string {
  return ts && /^\d{4}-\d{2}/.test(ts) ? ts.slice(0, 7) : 'unknown';
}

const orgDomain = (d: string | null): string | null => (d && !isPublicDomain(d) ? d : null);

/** Spec §2. Pure: same index → same scopes, same order. */
export function assignScopes(index: DossierIndex): Scope[] {
  const scopes = new Map<string, Scope>();
  const scope = (key: string, domain: string | null, month: string | null): Scope => {
    let s = scopes.get(key);
    if (!s) scopes.set(key, (s = { key, domain, month, companies: [], contacts: [], orphans: [] }));
    return s;
  };

  const companyKey = new Map<string, string>();
  const companySection = new Map<string, Section<CompanyRow>>();
  for (const row of index.companies) {
    const d = orgDomain(normalizeDomain(row.domain));
    const key = d ? `dom:${d}` : `co:${row.id}`;
    companyKey.set(row.id, key);
    const sec = { row, activities: [] };
    companySection.set(row.id, sec);
    scope(key, d, null).companies.push(sec);
  }

  const contactSection = new Map<string, Section<ContactRow>>();
  for (const row of index.contacts) {
    const d = orgDomain(emailDomain(row.email));
    let key: string;
    let domain: string | null = d;
    let month: string | null = null;
    if (d) key = `dom:${d}`;
    else {
      const company = [...row.companyIds].sort(cmpId).find((id) => companyKey.has(id));
      if (company) {
        key = companyKey.get(company)!;
        domain = scopes.get(key)!.domain;
      } else {
        month = monthOf(row.createdAt);
        key = `ind:${month}`;
      }
    }
    const sec = { row, activities: [] };
    contactSection.set(row.id, sec);
    scope(key, domain, month).contacts.push(sec);
  }

  for (const a of index.activities) {
    const contact = [...a.contactIds].sort(cmpId).find((id) => contactSection.has(id));
    if (contact) { contactSection.get(contact)!.activities.push(a); continue; }
    const company = [...a.companyIds].sort(cmpId).find((id) => companySection.has(id));
    if (company) { companySection.get(company)!.activities.push(a); continue; }
    const month = monthOf(a.ts);
    scope(`orphan:${month}`, null, month).orphans.push(a);
  }

  const byTs = (x: ActivityRow, y: ActivityRow) => ((x.ts ?? '') < (y.ts ?? '') ? -1 : (x.ts ?? '') > (y.ts ?? '') ? 1 : cmpId(x.id, y.id));
  const out = [...scopes.values()].sort((x, y) => (x.key < y.key ? -1 : x.key > y.key ? 1 : 0));
  for (const s of out) {
    s.companies.sort((x, y) => cmpId(x.row.id, y.row.id));
    s.contacts.sort((x, y) => {
      const cx = x.row.createdAt ?? '';
      const cy = y.row.createdAt ?? '';
      return cx < cy ? -1 : cx > cy ? 1 : cmpId(x.row.id, y.row.id);
    });
    for (const sec of [...s.companies, ...s.contacts]) sec.activities.sort(byTs);
    s.orphans.sort(byTs);
  }
  return out;
}
