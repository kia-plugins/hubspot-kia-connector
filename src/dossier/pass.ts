import type { Batch, DocumentInput, ExternalRef, Session } from '@kiagent/connector-sdk';
import type { HubSpotClient } from '../client';
import { isPassOwnedEmail } from '../ownership';
import { propsFor } from '../properties';
import {
  DOC_TYPE,
  PASS_TYPES,
  type DossierState,
  type HubSpotCursor,
  type HubSpotItem,
  type HubSpotRecord,
  type ListEnvelope,
  type LiveCursor,
  type PassTypeKey,
  type RenderContext,
} from '../types';
import { activityRow, companyRow, contactRow } from './blocks';
import { DOSSIER_DOC_TYPE, layoutScope, partId } from './layout';
import { assignScopes, type DossierIndex, type Scope } from './scope';

export const DOSSIER_EVERY_MS = 6 * 3_600_000;
export const DOSSIER_RETRY_MS = 3_600_000;
export const CHUNK_MAX_CHARS = 2_000_000;
export const SHRINK_RATIO = 0.5;
const PAGE_LIMIT = 100;

/** Associations each listing carries inline (spec §4 step 1). */
const LIST_ASSOC: Record<PassTypeKey, string[]> = {
  companies: [],
  contacts: ['companies'],
  tasks: ['contacts', 'companies'],
  emails: ['contacts', 'companies'],
};

export function emptyDossier(): DossierState {
  return { lastCompletedAt: null, attemptedAt: null, scopes: {}, counts: {} };
}

export function isPassDue(d: DossierState | undefined, nowMs: number): boolean {
  const s = d ?? emptyDossier();
  const since = (t: string | null) => (t ? nowMs - Date.parse(t) : Infinity);
  return since(s.lastCompletedAt) >= DOSSIER_EVERY_MS && since(s.attemptedAt) >= DOSSIER_RETRY_MS;
}

function listPath(type: PassTypeKey, after: string | null, ctx: RenderContext): string {
  const params = new URLSearchParams({ limit: String(PAGE_LIMIT), archived: 'false', properties: propsFor(type, ctx).join(',') });
  if (LIST_ASSOC[type].length) params.set('associations', LIST_ASSOC[type].join(','));
  if (after) params.set('after', after);
  return `/crm/v3/objects/${type}?${params.toString()}`;
}

/** Pages one type to the end. Returns the number of records seen, or null on abort. */
async function listAll(
  client: Pick<HubSpotClient, 'request'>,
  session: Session,
  type: PassTypeKey,
  ctx: RenderContext,
  onRecord: (r: HubSpotRecord) => void,
): Promise<number | null> {
  let after: string | null = null;
  let n = 0;
  do {
    if (session.signal.aborted) return null;
    const page: ListEnvelope = await client.request<ListEnvelope>('GET', listPath(type, after, ctx));
    for (const r of page.results ?? []) {
      n += 1;
      onRecord(r);
    }
    after = page.paging?.next?.after ?? null;
  } while (after);
  return n;
}

function foldedEmailRefs(scope: Scope): ExternalRef[] {
  const acts = [...scope.companies, ...scope.contacts].flatMap((s) => s.activities).concat(scope.orphans);
  return acts.filter((a) => a.kind === 'emails').map((a) => ({ externalId: a.id, type: DOC_TYPE.emails }));
}

/**
 * Spec §4. Full rebuild of every pass-owned record into dossier parts:
 * attemptedAt → list (render while listing) → chunks of ≤ chunkMaxChars,
 * one item per batch (atomic) → final batch with stale-part deletions.
 * Not resumable: an abort simply stops; the next attempt starts over.
 */
export async function* dossierPass(
  client: Pick<HubSpotClient, 'request'>,
  session: Session,
  cursor: LiveCursor,
  ctx: RenderContext,
  nowMs: number,
  chunkMaxChars: number = CHUNK_MAX_CHARS,
): AsyncGenerator<Batch<HubSpotCursor, HubSpotItem>> {
  const prev = cursor.dossier ?? emptyDossier();
  const startedAt = new Date(nowMs).toISOString();
  let state: DossierState = { ...prev, attemptedAt: startedAt };
  const snap = (): HubSpotCursor => structuredClone({ ...cursor, dossier: state });
  yield { phase: 'live', items: [], cursor: snap() };

  const index: DossierIndex = { companies: [], contacts: [], activities: [] };
  const counts: Partial<Record<PassTypeKey, number>> = {};
  for (const type of PASS_TYPES) {
    const n = await listAll(client, session, type, ctx, (r) => {
      if (type === 'companies') index.companies.push(companyRow(r, ctx));
      else if (type === 'contacts') index.contacts.push(contactRow(r, ctx));
      else if (type === 'tasks') index.activities.push(activityRow('tasks', r, ctx));
      else if (isPassOwnedEmail(r)) index.activities.push(activityRow('emails', r, ctx));
    });
    if (n === null) return;
    counts[type] = n;
  }

  const hi: Record<string, number> = { ...prev.scopes };
  const newP: Record<string, number> = {};
  let docs: DocumentInput[] = [];
  let chars = 0;
  let deletions: ExternalRef[] = [];
  const flush = (): Batch<HubSpotCursor, HubSpotItem> => {
    state = { ...state, scopes: { ...hi } };
    const b: Batch<HubSpotCursor, HubSpotItem> = {
      phase: 'live',
      items: docs.length ? [{ kind: 'dossier', docs }] : [],
      deletions,
      cursor: snap(),
    };
    docs = [];
    chars = 0;
    deletions = [];
    return b;
  };

  for (const scope of assignScopes(index)) {
    if (session.signal.aborted) return;
    const parts = layoutScope(scope, ctx.portalId);
    newP[scope.key] = parts.length;
    // Chunk by PARTS (spec §4): a giant scope spans several chunks; the
    // high-water mark rides each chunk's cursor so no committed part is lost.
    for (let i = 0; i < parts.length; i++) {
      if (session.signal.aborted) return;
      docs.push(parts[i]);
      chars += parts[i].markdown?.length ?? 0;
      hi[scope.key] = Math.max(hi[scope.key] ?? 0, i + 1);
      if (chars >= chunkMaxChars) yield flush();
    }
    deletions.push(...foldedEmailRefs(scope));
  }
  if (session.signal.aborted) return;
  if (docs.length || deletions.length) yield flush();

  const shrunk = PASS_TYPES.filter((t) => (prev.counts[t] ?? 0) > 0 && (counts[t] ?? 0) < (prev.counts[t] ?? 0) * SHRINK_RATIO);
  if (shrunk.length) {
    session.log('warn', `hubspot dossier pass: ${shrunk.join(', ')} listing shrank below ${SHRINK_RATIO * 100}% of the last pass — skipping deletions`);
    yield { phase: 'live', items: [], cursor: snap() };
    return;
  }

  const stale: ExternalRef[] = [];
  for (const [key, high] of Object.entries(hi)) {
    for (let i = newP[key] ?? 0; i < high; i++) stale.push({ externalId: partId(key, i), type: DOSSIER_DOC_TYPE });
  }
  state = { lastCompletedAt: startedAt, attemptedAt: startedAt, scopes: newP, counts };
  yield { phase: 'live', items: [], deletions: stale, cursor: snap() };
}
