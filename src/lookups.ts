import type { HubSpotClient } from './client';
import { ALL_TYPES, type RenderContext, type TypeKey } from './types';

interface OwnersEnvelope {
  results?: Array<{ id: string; firstName?: string; lastName?: string; email?: string }>;
  paging?: { next?: { after?: string } };
}

interface PipelinesEnvelope {
  results?: Array<{ id: string; label: string; stages?: Array<{ id: string; label: string }> }>;
}

interface PropertiesEnvelope {
  results?: Array<{ name: string; label?: string; hubspotDefined?: boolean }>;
}

type Client = Pick<HubSpotClient, 'request'>;

/** One fetch per pull: owners, pipeline/stage labels, custom property names.
 *  Attached to every item so toDocument stays pure. Sizes are small (owners
 *  page ≤100 × few pages, pipelines are tiny, one properties call per type). */
export async function fetchRenderContext(client: Client, portalId: string): Promise<RenderContext> {
  const owners: RenderContext['owners'] = {};
  let after: string | undefined;
  do {
    const page = await client.request<OwnersEnvelope>(
      'GET',
      `/crm/v3/owners/?limit=100${after ? `&after=${encodeURIComponent(after)}` : ''}`,
    );
    for (const o of page.results ?? []) {
      const name = [o.firstName, o.lastName].filter(Boolean).join(' ').trim();
      owners[o.id] = { name: name || o.email || `owner ${o.id}`, email: o.email };
    }
    after = page.paging?.next?.after;
  } while (after);

  const stageMap = async (kind: 'deals' | 'tickets') => {
    const out: Record<string, { pipeline: string; stage: string }> = {};
    const page = await client.request<PipelinesEnvelope>('GET', `/crm/v3/pipelines/${kind}`);
    for (const p of page.results ?? [])
      for (const s of p.stages ?? []) out[s.id] = { pipeline: p.label, stage: s.label };
    return out;
  };

  const customProps: RenderContext['customProps'] = {};
  for (const type of ALL_TYPES) {
    const page = await client.request<PropertiesEnvelope>('GET', `/crm/v3/properties/${type}`);
    const map: Record<string, string> = {};
    for (const p of page.results ?? [])
      if (p.hubspotDefined === false) map[p.name] = p.label ?? p.name;
    customProps[type] = map;
  }

  return {
    portalId,
    owners,
    dealStages: await stageMap('deals'),
    ticketStages: await stageMap('tickets'),
    customProps,
  };
}

export function ownerLabel(ctx: RenderContext, ownerId: string | null | undefined): string | null {
  if (!ownerId) return null;
  return ctx.owners[ownerId]?.name ?? null;
}
