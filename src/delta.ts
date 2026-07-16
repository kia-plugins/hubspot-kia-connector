import { fetchAttachmentItems } from './attachments';
import type { HubSpotClient } from './client';
import type { Batch, Session } from './kiagent-contracts';
import { propsFor } from './properties';
import {
  ALL_TYPES,
  DOC_TYPE,
  ENGAGEMENT_TYPES,
  LAST_MODIFIED_PROP,
  OBJECT_TYPES,
  type Associations,
  type HubSpotCursor,
  type HubSpotItem,
  type HubSpotRecord,
  type RenderContext,
  type SearchEnvelope,
  type TypeKey,
} from './types';

/** One 30-minute tick stays cheap: ~60 API calls, stalest types first;
 *  anything unfinished resumes next tick from its unadvanced watermark. */
export const DELTA_REQUEST_BUDGET = 60;
/** Search indexing lags writes; 5 minutes of overlap re-covers the boundary. */
export const OVERLAP_MS = 5 * 60_000;
/** HubSpot search refuses paging past 10k results — re-window before that. */
const SEARCH_PAGE_CAP = 9_900;
const PAGE_LIMIT = 100;

type LiveCursor = Extract<HubSpotCursor, { phase: 'live' }>;

export async function batchReadAssociations(
  client: HubSpotClient,
  fromType: TypeKey,
  ids: string[],
): Promise<Record<string, Associations>> {
  const out: Record<string, Associations> = {};
  if (ids.length === 0) return out;
  for (const to of OBJECT_TYPES) {
    if (to === fromType) continue;
    const res = await client.request<{
      results?: Array<{ from: { id: string }; to: Array<{ toObjectId: number | string }> }>;
    }>('POST', `/crm/v4/associations/${fromType}/${to}/batch/read`, {
      inputs: ids.map((id) => ({ id })),
    });
    for (const row of res.results ?? []) {
      const bucket = (out[row.from.id] ??= {});
      const list = row.to.map((t) => String(t.toObjectId));
      if (list.length) bucket[to] = [...new Set([...(bucket[to] ?? []), ...list])];
    }
  }
  return out;
}

const isEngagement = (t: TypeKey): boolean => (ENGAGEMENT_TYPES as readonly string[]).includes(t);

/**
 * Per-type ascending search on last-modified ≥ watermark − overlap. After each
 * page the type's watermark advances to the last emitted record's timestamp —
 * items and cursor commit in one transaction, so a crash re-does at most one
 * page. Hitting the 10k pager cap re-issues a fresh window from the advanced
 * watermark instead of paging on.
 */
export async function* delta(
  client: HubSpotClient,
  session: Session,
  cursor: LiveCursor,
  ctx: RenderContext,
): AsyncGenerator<Batch<HubSpotCursor, HubSpotItem>> {
  const watermarks = { ...cursor.watermarks };
  const budgetLeft = () => DELTA_REQUEST_BUDGET - client.requestCount;
  const order = [...ALL_TYPES].sort((a, b) => (watermarks[a] < watermarks[b] ? -1 : 1));

  for (const step of order) {
    if (session.signal.aborted) return;
    if (budgetLeft() <= 0) break;
    const prop = LAST_MODIFIED_PROP[step];
    let sinceMs = Date.parse(watermarks[step]) - OVERLAP_MS;
    let after: string | undefined;

    for (;;) {
      if (session.signal.aborted) return;
      if (budgetLeft() <= 0) break;

      const page = await client.request<SearchEnvelope>('POST', `/crm/v3/objects/${step}/search`, {
        filterGroups: [{ filters: [{ propertyName: prop, operator: 'GTE', value: String(sinceMs) }] }],
        sorts: [{ propertyName: prop, direction: 'ASCENDING' }],
        properties: propsFor(step, ctx),
        limit: PAGE_LIMIT,
        ...(after ? { after } : {}),
      });

      const records = page.results ?? [];
      if (records.length === 0) break;

      const assocMap = await batchReadAssociations(client, step, records.map((r) => r.id));
      const items: HubSpotItem[] = [];
      let maxSeen = watermarks[step];
      for (const record of records) {
        if (session.signal.aborted) return;
        items.push({ kind: step, record, assoc: assocMap[record.id] ?? {}, ctx });
        if (isEngagement(step) && record.properties.hs_attachment_ids) {
          items.push(...(await fetchAttachmentItems(client, session, record, DOC_TYPE[step])));
        }
        const lm = record.properties[prop];
        if (lm && lm > maxSeen) maxSeen = lm;
      }
      watermarks[step] = maxSeen;

      yield {
        phase: 'live',
        items,
        cursor: structuredClone({ phase: 'live', watermarks, archiveSweep: cursor.archiveSweep } as HubSpotCursor),
      };

      const nextAfter = page.paging?.next?.after;
      if (!nextAfter) break;
      if (Number(nextAfter) >= SEARCH_PAGE_CAP) {
        // Re-window: fresh search from the advanced watermark, no `after`.
        sinceMs = Date.parse(watermarks[step]);
        after = undefined;
      } else {
        after = nextAfter;
      }
    }
  }

  yield* archivedSweep(client, session, watermarks, cursor.archiveSweep, budgetLeft);
}

/**
 * Deletion channel: HubSpot search excludes archived records, and a full
 * reconcile() listing of a large portal is thousands of requests per cycle —
 * so instead each tick pages the (small) archived=true listing per type,
 * emitting Batch.deletions. Round-robin position persists in
 * cursor.archiveSweep and clears after a full pass. Archived engagements also
 * delete their attachment file docs (ids still readable on the archived
 * record). GDPR hard-deletes never appear here — documented limitation.
 */
async function* archivedSweep(
  client: HubSpotClient,
  session: Session,
  watermarks: Record<TypeKey, string>,
  sweep: LiveCursor['archiveSweep'],
  budgetLeft: () => number,
): AsyncGenerator<Batch<HubSpotCursor, HubSpotItem>> {
  let idx = sweep ? Math.max(0, ALL_TYPES.indexOf(sweep.step)) : 0;
  let after: string | null = sweep?.after ?? null;

  for (; idx < ALL_TYPES.length; idx++) {
    const step = ALL_TYPES[idx];
    for (;;) {
      if (session.signal.aborted) return;
      if (budgetLeft() <= 0) {
        // Persist the resume point; nothing else changes this cursor.
        yield {
          phase: 'live',
          items: [],
          cursor: structuredClone({ phase: 'live', watermarks, archiveSweep: { step, after } } as HubSpotCursor),
        };
        return;
      }
      const params = new URLSearchParams({
        limit: '100',
        archived: 'true',
        properties: 'hs_attachment_ids',
      });
      if (after) params.set('after', after);
      const page = await client.request<SearchEnvelope>('GET', `/crm/v3/objects/${step}?${params.toString()}`);

      const deletions = (page.results ?? []).flatMap((r: HubSpotRecord) => {
        const refs = [{ externalId: r.id, type: DOC_TYPE[step] }];
        for (const fileId of (r.properties?.hs_attachment_ids ?? '').split(';').map((s) => s.trim()).filter(Boolean)) {
          refs.push({ externalId: fileId, type: 'file' });
        }
        return refs;
      });

      after = page.paging?.next?.after ?? null;
      const nextSweep = after
        ? { step, after }
        : idx + 1 < ALL_TYPES.length
          ? { step: ALL_TYPES[idx + 1], after: null }
          : undefined;

      if (deletions.length > 0 || nextSweep === undefined) {
        yield {
          phase: 'live',
          items: [],
          deletions,
          cursor: structuredClone({ phase: 'live', watermarks, ...(nextSweep ? { archiveSweep: nextSweep } : {}) } as HubSpotCursor),
        };
      }
      if (!after) break;
    }
  }
}
