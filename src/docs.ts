import type { DocumentInput, ExternalRef } from './kiagent-contracts';
import { ownerLabel } from './lookups';
import { propLines, truncate } from './render';
import {
  DOC_TYPE,
  OBJECT_TYPE_ID,
  type Associations,
  type HubSpotItem,
  type HubSpotRecord,
  type ObjectTypeKey,
  type RenderContext,
  type TypeKey,
} from './types';

export function recordUrl(ctx: RenderContext, objectType: ObjectTypeKey, id: string): string {
  return `https://app.hubspot.com/contacts/${ctx.portalId}/record/${OBJECT_TYPE_ID[objectType]}/${id}`;
}

/** Engagements parent onto their most specific associated object. */
const PARENT_PRIORITY: ObjectTypeKey[] = ['contacts', 'deals', 'tickets', 'companies'];

export function primaryParent(assoc: Associations): ExternalRef | null {
  for (const t of PARENT_PRIORITY) {
    const id = assoc[t]?.[0];
    if (id) return { externalId: id, type: DOC_TYPE[t] };
  }
  return null;
}

const p = (r: HubSpotRecord, name: string): string | null => r.properties[name] ?? null;

/** Custom (non-hubspotDefined) properties rendered with their human labels. */
function customLines(kind: TypeKey, record: HubSpotRecord, ctx: RenderContext): string {
  const map = ctx.customProps[kind] ?? {};
  return propLines(Object.entries(map).map(([name, label]) => [label, p(record, name)]));
}

function baseMetadata(kind: TypeKey, record: HubSpotRecord, assoc: Associations, ctx: RenderContext) {
  return {
    hubspot_object_type: kind,
    owner: ownerLabel(ctx, p(record, 'hubspot_owner_id')),
    associations: assoc,
    last_modified_at: p(record, 'hs_lastmodifieddate') ?? p(record, 'lastmodifieddate'),
  };
}

function objectDoc(kind: ObjectTypeKey, record: HubSpotRecord, assoc: Associations, ctx: RenderContext): DocumentInput {
  const owner = ownerLabel(ctx, p(record, 'hubspot_owner_id'));
  let title: string;
  let lines: string;
  const metadata: Record<string, unknown> = baseMetadata(kind, record, assoc, ctx);

  if (kind === 'contacts') {
    const name = [p(record, 'firstname'), p(record, 'lastname')].filter(Boolean).join(' ').trim();
    const company = p(record, 'company');
    title = name ? (company ? `${name} — ${company}` : name) : (p(record, 'email') ?? `contact ${record.id}`);
    metadata.lifecycle_stage = p(record, 'lifecyclestage');
    lines = propLines([
      ['Email', p(record, 'email')],
      ['Phone', p(record, 'phone')],
      ['Mobile', p(record, 'mobilephone')],
      ['Job title', p(record, 'jobtitle')],
      ['Company', company],
      ['Lifecycle stage', p(record, 'lifecyclestage')],
      ['Lead status', p(record, 'hs_lead_status')],
      ['Owner', owner],
      ['City', p(record, 'city')],
      ['State', p(record, 'state')],
      ['Country', p(record, 'country')],
      ['Website', p(record, 'website')],
    ]);
  } else if (kind === 'companies') {
    title = p(record, 'name') ?? p(record, 'domain') ?? `company ${record.id}`;
    metadata.lifecycle_stage = p(record, 'lifecyclestage');
    lines = propLines([
      ['Domain', p(record, 'domain')],
      ['Industry', p(record, 'industry')],
      ['Phone', p(record, 'phone')],
      ['City', p(record, 'city')],
      ['State', p(record, 'state')],
      ['Country', p(record, 'country')],
      ['Employees', p(record, 'numberofemployees')],
      ['Annual revenue', p(record, 'annualrevenue')],
      ['Lifecycle stage', p(record, 'lifecyclestage')],
      ['Owner', owner],
    ]);
    const desc = p(record, 'description');
    if (desc) lines += `\n\n${desc}`;
  } else if (kind === 'deals') {
    title = p(record, 'dealname') ?? `deal ${record.id}`;
    const stage = ctx.dealStages[p(record, 'dealstage') ?? ''];
    metadata.pipeline = stage?.pipeline ?? null;
    metadata.stage = stage?.stage ?? null;
    lines = propLines([
      ['Amount', p(record, 'amount')],
      ['Stage', stage?.stage ?? p(record, 'dealstage')],
      ['Pipeline', stage?.pipeline ?? null],
      ['Close date', p(record, 'closedate')],
      ['Type', p(record, 'dealtype')],
      ['Owner', owner],
    ]);
    const desc = p(record, 'description');
    if (desc) lines += `\n\n${desc}`;
  } else {
    title = p(record, 'subject') ?? `ticket ${record.id}`;
    const stage = ctx.ticketStages[p(record, 'hs_pipeline_stage') ?? ''];
    metadata.pipeline = stage?.pipeline ?? null;
    metadata.stage = stage?.stage ?? null;
    lines = propLines([
      ['Stage', stage?.stage ?? p(record, 'hs_pipeline_stage')],
      ['Pipeline', stage?.pipeline ?? null],
      ['Priority', p(record, 'hs_ticket_priority')],
      ['Owner', owner],
    ]);
    const content = p(record, 'content');
    if (content) lines += `\n\n${content}`;
  }

  const custom = customLines(kind, record, ctx);
  const markdown = [`# ${title}`, lines, custom].filter(Boolean).join('\n\n');

  return {
    externalId: record.id,
    type: DOC_TYPE[kind],
    title,
    markdown,
    url: recordUrl(ctx, kind, record.id),
    metadata,
    createdAt: p(record, 'createdate'),
  };
}

export function renderItem(item: HubSpotItem): DocumentInput | DocumentInput[] | null {
  if (item.kind === 'file') return null; // Task 6
  const { kind, record, assoc, ctx } = item;
  if (kind === 'contacts' || kind === 'companies' || kind === 'deals' || kind === 'tickets') {
    return objectDoc(kind, record, assoc, ctx);
  }
  return null; // engagements: Task 6
}
