import type { DocumentInput, ExternalRef } from './kiagent-contracts';
import { ownerLabel } from './lookups';
import { htmlToText, propLines, truncate } from './render';
import {
  DOC_TYPE,
  OBJECT_TYPE_ID,
  type Associations,
  type EngagementTypeKey,
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

interface ParsedHeaders {
  from: string | null;
  to: string[];
}

function parseEmailHeaders(raw: string | null): ParsedHeaders {
  if (!raw) return { from: null, to: [] };
  try {
    const h = JSON.parse(raw) as {
      from?: { email?: string };
      to?: Array<{ email?: string }>;
    };
    return {
      from: h.from?.email ?? null,
      to: (h.to ?? []).map((t) => t.email).filter((e): e is string => Boolean(e)),
    };
  } catch {
    return { from: null, to: [] };
  }
}

function engagementDoc(
  kind: EngagementTypeKey,
  record: HubSpotRecord,
  assoc: Associations,
  ctx: RenderContext,
): DocumentInput {
  const owner = ownerLabel(ctx, p(record, 'hubspot_owner_id'));
  const parent = primaryParent(assoc);
  const metadata: Record<string, unknown> = {
    ...baseMetadata(kind, record, assoc, ctx),
    hubspot_engagement_type: kind,
  };

  let title: string | null = null;
  let header = '';
  let body = '';

  if (kind === 'notes') {
    body = htmlToText(p(record, 'hs_note_body') ?? '');
    title = truncate(body.split('\n')[0] ?? '', 80) || `note ${record.id}`;
    header = propLines([['Owner', owner]]);
  } else if (kind === 'emails') {
    const headers = parseEmailHeaders(p(record, 'hs_email_headers'));
    body = p(record, 'hs_email_text') ?? htmlToText(p(record, 'hs_email_html') ?? '');
    title = p(record, 'hs_email_subject') ?? (truncate(body.split('\n')[0] ?? '', 80) || `email ${record.id}`);
    header = propLines([
      ['From', headers.from],
      ['To', headers.to.join(', ') || null],
      ['Direction', p(record, 'hs_email_direction')],
      ['Status', p(record, 'hs_email_status')],
    ]);
    metadata.direction = p(record, 'hs_email_direction');
    metadata.from = headers.from;
    metadata.to = headers.to;
    metadata.status = p(record, 'hs_email_status');
  } else if (kind === 'calls') {
    body = htmlToText(p(record, 'hs_call_body') ?? '');
    title = p(record, 'hs_call_title') ?? `Call — ${p(record, 'hs_timestamp') ?? record.id}`;
    header = propLines([
      ['Direction', p(record, 'hs_call_direction')],
      ['Duration (ms)', p(record, 'hs_call_duration')],
      ['Owner', owner],
    ]);
  } else if (kind === 'meetings') {
    const agenda = htmlToText(p(record, 'hs_meeting_body') ?? '');
    const notes = htmlToText(p(record, 'hs_internal_meeting_notes') ?? '');
    body = [agenda, notes].filter(Boolean).join('\n\n');
    title = p(record, 'hs_meeting_title') ?? `Meeting — ${p(record, 'hs_timestamp') ?? record.id}`;
    header = propLines([
      ['Start', p(record, 'hs_meeting_start_time')],
      ['End', p(record, 'hs_meeting_end_time')],
      ['Location', p(record, 'hs_meeting_location')],
      ['Owner', owner],
    ]);
  } else {
    body = htmlToText(p(record, 'hs_task_body') ?? '');
    title = p(record, 'hs_task_subject') ?? `task ${record.id}`;
    header = propLines([
      ['Status', p(record, 'hs_task_status')],
      ['Priority', p(record, 'hs_task_priority')],
      ['Owner', owner],
    ]);
  }

  const markdown = [`# ${title}`, header, body].filter(Boolean).join('\n\n');
  const parentUrl =
    parent === null
      ? undefined
      : recordUrl(
          ctx,
          (Object.entries(DOC_TYPE).find(([, v]) => v === parent.type)?.[0] ?? 'contacts') as ObjectTypeKey,
          parent.externalId,
        );

  return {
    externalId: record.id,
    type: DOC_TYPE[kind],
    title,
    markdown,
    ...(parentUrl ? { url: parentUrl } : {}),
    metadata,
    createdAt: p(record, 'hs_timestamp'),
    ...(parent ? { parent } : {}),
  };
}

const MAX_FILE_BYTES = 50 * 1024 * 1024;

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
  if (item.kind === 'file') {
    return {
      externalId: item.fileId,
      type: 'file',
      title: item.filename,
      markdown: null,
      ...(item.bytes ? { binary: { bytes: item.bytes, mime: item.mime, filename: item.filename } } : {}),
      metadata: {
        hubspot_file_id: item.fileId,
        size: item.size,
        ...(item.bytes ? {} : { extraction_status: 'too_large' }),
      },
      createdAt: item.createdAt,
      parent: item.parent,
    };
  }
  const { kind, record, assoc, ctx } = item;
  if (kind === 'contacts' || kind === 'companies' || kind === 'deals' || kind === 'tickets') {
    return objectDoc(kind, record, assoc, ctx);
  }
  return engagementDoc(kind, record, assoc, ctx);
}

export { MAX_FILE_BYTES };
