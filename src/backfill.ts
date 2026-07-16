import { fetchAttachmentItems } from './attachments';
import type { HubSpotClient } from './client';
import type { Batch, Session } from './kiagent-contracts';
import { propsFor } from './properties';
import {
  ALL_TYPES,
  DOC_TYPE,
  ENGAGEMENT_TYPES,
  OBJECT_TYPES,
  type Associations,
  type HubSpotCursor,
  type HubSpotItem,
  type HubSpotRecord,
  type ListEnvelope,
  type RenderContext,
  type TypeKey,
} from './types';

const PAGE_LIMIT = 100;

export function assocFromRecord(record: HubSpotRecord): Associations {
  const out: Associations = {};
  for (const t of OBJECT_TYPES) {
    const ids = record.associations?.[t]?.results?.map((r) => r.id) ?? [];
    if (ids.length) out[t] = [...new Set(ids)];
  }
  return out;
}

const isEngagement = (t: TypeKey): boolean => (ENGAGEMENT_TYPES as readonly string[]).includes(t);

function listPath(type: TypeKey, after: string | null, props: string[]): string {
  const params = new URLSearchParams({
    limit: String(PAGE_LIMIT),
    archived: 'false',
    properties: props.join(','),
    associations: OBJECT_TYPES.join(','),
  });
  if (after) params.set('after', after);
  return `/crm/v3/objects/${type}?${params.toString()}`;
}

/**
 * Phased, resumable backfill: every type in ALL_TYPES order (objects before
 * engagements so engagement parent refs resolve against already-committed
 * docs), one Batch per page — each yield is a crash-safe checkpoint. Finishes
 * with an empty `live` batch so delta never sees a backfill cursor. Watermarks
 * are stamped with backfillStartedAt (delta's overlap re-covers anything
 * modified mid-backfill).
 */
export async function* backfill(
  client: HubSpotClient,
  session: Session,
  cursor: Extract<HubSpotCursor, { phase: 'backfill' }> | null,
  ctx: RenderContext,
): AsyncGenerator<Batch<HubSpotCursor, HubSpotItem>> {
  const watermarks = { ...(cursor?.watermarks ?? {}) };
  const startedAt = cursor?.backfillStartedAt ?? new Date().toISOString();
  let stepIdx = Math.max(0, ALL_TYPES.indexOf(cursor?.step ?? 'companies'));
  let after: string | null = cursor?.after ?? null;

  for (; stepIdx < ALL_TYPES.length; stepIdx++) {
    const step = ALL_TYPES[stepIdx];
    for (;;) {
      if (session.signal.aborted) return;
      const page = await client.request<ListEnvelope>('GET', listPath(step, after, propsFor(step, ctx)));

      const items: HubSpotItem[] = [];
      for (const record of page.results ?? []) {
        if (session.signal.aborted) return;
        const assoc = assocFromRecord(record);
        items.push({ kind: step, record, assoc, ctx });
        if (isEngagement(step) && record.properties.hs_attachment_ids) {
          items.push(...(await fetchAttachmentItems(client, session, record, DOC_TYPE[step])));
        }
      }

      after = page.paging?.next?.after ?? null;
      if (!after) watermarks[step] = startedAt;
      const isLastType = stepIdx === ALL_TYPES.length - 1;
      const next: HubSpotCursor = after
        ? { phase: 'backfill', step, after, watermarks: { ...watermarks }, backfillStartedAt: startedAt }
        : isLastType
          ? { phase: 'live', watermarks: { ...watermarks } as Record<TypeKey, string> }
          : {
              phase: 'backfill',
              step: ALL_TYPES[stepIdx + 1] ?? step,
              after: null,
              watermarks: { ...watermarks },
              backfillStartedAt: startedAt,
            };
      yield { phase: 'backfill', items, cursor: structuredClone(next) };
      if (!after) break;
    }
  }

  const full = Object.fromEntries(ALL_TYPES.map((t) => [t, watermarks[t] ?? startedAt])) as Record<TypeKey, string>;
  yield { phase: 'live', items: [], cursor: { phase: 'live', watermarks: full } };
}
