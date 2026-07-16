import type { RenderContext, TypeKey } from './types';

export const STANDARD_PROPS: Record<TypeKey, string[]> = {
  contacts: ['firstname', 'lastname', 'email', 'phone', 'mobilephone', 'jobtitle', 'company', 'lifecyclestage', 'hs_lead_status', 'hubspot_owner_id', 'city', 'state', 'country', 'website', 'createdate', 'lastmodifieddate'],
  companies: ['name', 'domain', 'industry', 'phone', 'city', 'state', 'country', 'numberofemployees', 'annualrevenue', 'description', 'lifecyclestage', 'hubspot_owner_id', 'createdate', 'hs_lastmodifieddate'],
  deals: ['dealname', 'amount', 'dealstage', 'pipeline', 'closedate', 'dealtype', 'description', 'hubspot_owner_id', 'createdate', 'hs_lastmodifieddate'],
  tickets: ['subject', 'content', 'hs_pipeline', 'hs_pipeline_stage', 'hs_ticket_priority', 'hubspot_owner_id', 'createdate', 'hs_lastmodifieddate'],
  notes: ['hs_note_body', 'hs_attachment_ids', 'hs_timestamp', 'hubspot_owner_id', 'hs_lastmodifieddate'],
  calls: ['hs_call_title', 'hs_call_body', 'hs_call_direction', 'hs_call_duration', 'hs_timestamp', 'hubspot_owner_id', 'hs_lastmodifieddate'],
  meetings: ['hs_meeting_title', 'hs_meeting_body', 'hs_internal_meeting_notes', 'hs_meeting_start_time', 'hs_meeting_end_time', 'hs_meeting_location', 'hs_attachment_ids', 'hs_timestamp', 'hubspot_owner_id', 'hs_lastmodifieddate'],
  tasks: ['hs_task_subject', 'hs_task_body', 'hs_task_status', 'hs_task_priority', 'hs_timestamp', 'hubspot_owner_id', 'hs_lastmodifieddate'],
  emails: ['hs_email_subject', 'hs_email_text', 'hs_email_html', 'hs_email_direction', 'hs_email_status', 'hs_email_headers', 'hs_attachment_ids', 'hs_timestamp', 'hubspot_owner_id', 'hs_lastmodifieddate'],
};

export function propsFor(type: TypeKey, ctx: RenderContext): string[] {
  const custom = Object.keys(ctx.customProps[type] ?? {});
  return [...new Set([...STANDARD_PROPS[type], ...custom])];
}
