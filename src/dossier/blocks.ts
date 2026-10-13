import { assocFromRecord } from '../backfill';
import { parseEmailHeaders, recordUrl, renderItem } from '../docs';
import { htmlToText, truncate } from '../render';
import type { DocumentInput } from '@kiagent/connector-sdk';
import type { HubSpotRecord, RenderContext } from '../types';
import type { ActivityRow, CompanyRow, ContactRow } from './scope';

export const BLOCK_MAX = 6000;
export const FOLD_BODY_MAX = 4000;
export const TRUNC_MARK = '… [truncated — open in HubSpot]';
/** Headings stay short so the first line (name + link) always survives the cap. */
const HEADING_NAME_MAX = 200;

export function capText(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - TRUNC_MARK.length - 1).trimEnd()}\n${TRUNC_MARK}`;
}

const prop = (r: HubSpotRecord, k: string): string | null => r.properties[k] ?? null;

/** Today's object renderer, minus its `# title` line. */
function objectBody(kind: 'companies' | 'contacts', record: HubSpotRecord, ctx: RenderContext): { title: string; body: string } {
  const doc = renderItem({ kind, record, assoc: assocFromRecord(record), ctx }) as DocumentInput;
  return { title: doc.title ?? record.id, body: (doc.markdown ?? '').split('\n').slice(1).join('\n').trim() };
}

export function companyRow(record: HubSpotRecord, ctx: RenderContext): CompanyRow {
  const { title, body } = objectBody('companies', record, ctx);
  const heading = `## Company: ${truncate(title, HEADING_NAME_MAX)} · [open](${recordUrl(ctx, 'companies', record.id)})`;
  return {
    id: record.id,
    domain: prop(record, 'domain'),
    name: title,
    createdAt: prop(record, 'createdate') ?? record.createdAt ?? null,
    block: capText([heading, body].filter(Boolean).join('\n'), BLOCK_MAX),
  };
}

export function contactRow(record: HubSpotRecord, ctx: RenderContext): ContactRow {
  const { title, body } = objectBody('contacts', record, ctx);
  const heading = `## ${truncate(title, HEADING_NAME_MAX)} · [open](${recordUrl(ctx, 'contacts', record.id)})`;
  return {
    id: record.id,
    email: prop(record, 'email'),
    name: title,
    createdAt: prop(record, 'createdate') ?? record.createdAt ?? null,
    companyIds: assocFromRecord(record).companies ?? [],
    block: capText([heading, body].filter(Boolean).join('\n'), BLOCK_MAX),
  };
}

const indent = (s: string) => s.split('\n').map((l) => (l ? `  ${l}` : l)).join('\n');

export function activityRow(kind: 'emails' | 'tasks', record: HubSpotRecord, ctx: RenderContext): ActivityRow {
  void ctx;
  const ts = prop(record, 'hs_timestamp');
  const date = ts ? ts.slice(0, 10) : 'undated';
  let line: string;
  let body: string;
  if (kind === 'emails') {
    const from = parseEmailHeaders(prop(record, 'hs_email_headers')).from;
    const subject = truncate(prop(record, 'hs_email_subject') ?? '(no subject)', HEADING_NAME_MAX);
    line = `- ${date} · Email sent${from ? ` (${from})` : ''} · "${subject}"`;
    body = capText(prop(record, 'hs_email_text') ?? htmlToText(prop(record, 'hs_email_html') ?? ''), FOLD_BODY_MAX);
  } else {
    const subject = truncate(prop(record, 'hs_task_subject') ?? `task ${record.id}`, HEADING_NAME_MAX);
    const status = prop(record, 'hs_task_status');
    line = `- ${date} · Task · ${subject}${status ? ` · ${status}` : ''}`;
    body = htmlToText(prop(record, 'hs_task_body') ?? '');
  }
  const assoc = assocFromRecord(record);
  return {
    id: record.id,
    kind,
    ts,
    contactIds: assoc.contacts ?? [],
    companyIds: assoc.companies ?? [],
    block: capText(body ? `${line}\n${indent(body.trim())}` : line, BLOCK_MAX),
  };
}
