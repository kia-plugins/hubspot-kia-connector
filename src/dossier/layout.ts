import type { DocumentInput } from '@kiagent/connector-sdk';
import { recordUrl } from '../docs';
import { truncate } from '../render';
import type { RenderContext } from '../types';
import type { Scope } from './scope';

export const PART_MAX_CHARS = 8000;
export const DOSSIER_DOC_TYPE = 'hubspot.dossier';
/** Part header + one continuation heading always fit beside a BLOCK_MAX block. */
const HEADER_RESERVE = 1_000;
const BODY_MAX = PART_MAX_CHARS - HEADER_RESERVE;
const TITLE_MAX = 200;

export const partId = (key: string, i: number): string => `hubspot-dossier:${key}:${i}`;

interface Unit {
  text: string;
  /** Heading repeated when this unit opens a part mid-section; null for a section's own heading. */
  cont: string | null;
  contactId?: string;
  companyId?: string;
  engagementId?: string;
  email?: string | null;
  ts: string | null;
}

function units(scope: Scope): Unit[] {
  const out: Unit[] = [];
  for (const { row, activities } of scope.companies) {
    out.push({ text: row.block, cont: null, companyId: row.id, ts: row.createdAt });
    const cont = `## Company: ${truncate(row.name, TITLE_MAX)} (cont.)`;
    for (const a of activities) out.push({ text: a.block, cont, companyId: row.id, engagementId: a.id, ts: a.ts });
  }
  for (const { row, activities } of scope.contacts) {
    out.push({ text: row.block, cont: null, contactId: row.id, email: row.email, ts: row.createdAt });
    const cont = `## ${truncate(row.name, TITLE_MAX)} (cont.)`;
    for (const a of activities) out.push({ text: a.block, cont, contactId: row.id, email: row.email, engagementId: a.id, ts: a.ts });
  }
  for (const a of scope.orphans) out.push({ text: a.block, cont: null, engagementId: a.id, ts: a.ts });
  return out;
}

function baseTitle(scope: Scope): string {
  const kind = scope.key.slice(0, scope.key.indexOf(':'));
  if (kind === 'ind') return `Individuals — ${scope.month}`;
  if (kind === 'orphan') return `Unassigned activity — ${scope.month}`;
  if (scope.companies.length === 1) {
    const name = truncate(scope.companies[0].row.name, TITLE_MAX);
    return scope.domain ? `${name} (${scope.domain})` : name;
  }
  return scope.domain ?? scope.key;
}

function subline(scope: Scope): string {
  const kind = scope.key.slice(0, scope.key.indexOf(':'));
  if (kind === 'dom') return `Organisation: ${scope.domain}`;
  if (kind === 'co') return `Company record ${scope.key.slice(3)}`;
  if (kind === 'ind') return `Contacts without a company domain, created ${scope.month}`;
  return `Sequence emails and tasks with no contact or company, ${scope.month}`;
}

/** Spec §3: greedy packing into ≤ PART_MAX_CHARS parts, no totals anywhere. */
export function layoutScope(scope: Scope, portalId: string): DocumentInput[] {
  const all = units(scope);
  const groups: Unit[][] = [];
  let cur: Unit[] = [];
  let len = 0;
  const cost = (u: Unit, first: boolean) => (first ? (u.cont ? u.cont.length + 2 : 0) : 2) + u.text.length;
  for (const u of all) {
    if (cur.length && len + cost(u, false) > BODY_MAX) {
      groups.push(cur);
      cur = [];
      len = 0;
    }
    len += cost(u, cur.length === 0);
    cur.push(u);
  }
  if (cur.length) groups.push(cur);

  const title = baseTitle(scope);
  const ctx = { portalId } as RenderContext;
  const soleCompany = scope.companies.length === 1 ? scope.companies[0].row.id : null;
  return groups.map((g, i) => {
    const suffix = i > 0 ? ` — part ${i + 1}` : '';
    const header = `# ${title}${suffix}\n${subline(scope)}${i > 0 ? ` · part ${i + 1}` : ''}`;
    const markdown = [header, ...(g[0].cont ? [g[0].cont] : []), ...g.map((u) => u.text)].join('\n\n');
    const uniq = (xs: Array<string | null | undefined>) => [...new Set(xs.filter((x): x is string => Boolean(x)))];
    const contactIds = uniq(g.map((u) => u.contactId));
    const createdAt = g.reduce<string | null>((m, u) => (u.ts && (!m || u.ts > m) ? u.ts : m), null);
    const url = soleCompany
      ? recordUrl(ctx, 'companies', soleCompany)
      : contactIds[0]
        ? recordUrl(ctx, 'contacts', contactIds[0])
        : uniq(g.map((u) => u.companyId))[0]
          ? recordUrl(ctx, 'companies', uniq(g.map((u) => u.companyId))[0])
          : undefined;
    return {
      externalId: partId(scope.key, i),
      type: DOSSIER_DOC_TYPE,
      title: `${title}${suffix}`,
      markdown,
      ...(url ? { url } : {}),
      metadata: {
        scope: scope.key,
        ...(scope.domain ? { domain: scope.domain } : {}),
        part: i,
        contactIds,
        companyIds: uniq(g.map((u) => u.companyId)),
        engagementIds: uniq(g.map((u) => u.engagementId)),
        participants: uniq(g.map((u) => u.email?.toLowerCase())),
      },
      createdAt,
    };
  });
}
