import { renderItem } from '../docs';
import type { DocumentInput } from '@kiagent/connector-sdk';
import { ctx } from '../testing/fixtures';
import type { HubSpotItem } from '../types';

const one = (item: HubSpotItem): DocumentInput => renderItem(item) as DocumentInput;

describe('renderItem: note', () => {
  it('converts the HTML body, parents to the contact, links the parent record', () => {
    const doc = one({
      kind: 'notes',
      record: {
        id: '9001',
        properties: { hs_note_body: '<p>Call went <b>well</b></p>', hs_timestamp: '2026-03-02T10:00:00Z', hubspot_owner_id: '9' },
      },
      assoc: { contacts: ['501'], companies: ['77'] },
      ctx,
    });
    expect(doc.type).toBe('hubspot.note');
    expect(doc.title).toBe('Call went well');
    expect(doc.markdown).toContain('Call went well');
    expect(doc.parent).toEqual({ externalId: '501', type: 'hubspot.contact' });
    expect(doc.url).toBe('https://app.hubspot.com/contacts/123/record/0-1/501');
    expect(doc.createdAt).toBe('2026-03-02T10:00:00Z');
    expect(doc.metadata.hubspot_engagement_type).toBe('notes');
    expect(doc.metadata.associations).toEqual({ contacts: ['501'], companies: ['77'] });
  });
});

describe('renderItem: email', () => {
  it('uses text body, parses headers into from/to metadata', () => {
    const doc = one({
      kind: 'emails',
      record: {
        id: '9002',
        properties: {
          hs_email_subject: 'Re: renewal terms',
          hs_email_text: 'Sounds good, see attached.',
          hs_email_html: '<p>Sounds good</p>',
          hs_email_direction: 'INCOMING_EMAIL',
          hs_email_status: 'SENT',
          hs_email_headers: JSON.stringify({ from: { email: 'jane@acme.com', firstName: 'Jane' }, to: [{ email: 'me@us.co' }] }),
          hs_timestamp: '2026-03-03T09:00:00Z',
        },
      },
      assoc: { deals: ['88'] },
      ctx,
    });
    expect(doc.type).toBe('hubspot.email');
    expect(doc.title).toBe('Re: renewal terms');
    expect(doc.markdown).toContain('Sounds good, see attached.');
    expect(doc.markdown).toContain('**From:** jane@acme.com');
    expect(doc.metadata.direction).toBe('INCOMING_EMAIL');
    expect(doc.metadata.from).toBe('jane@acme.com');
    expect(doc.metadata.to).toEqual(['me@us.co']);
    expect(doc.metadata.status).toBe('SENT');
    expect(doc.parent).toEqual({ externalId: '88', type: 'hubspot.deal' });
  });

  it('falls back to html body and survives unparseable headers', () => {
    const doc = one({
      kind: 'emails',
      record: {
        id: '9003',
        properties: { hs_email_html: '<p>Only html</p>', hs_email_headers: 'not-json', hs_timestamp: '2026-03-04T09:00:00Z' },
      },
      assoc: {},
      ctx,
    });
    expect(doc.markdown).toContain('Only html');
    expect(doc.title).toBe('Only html'); // subject fallback: first line of body
    expect(doc.parent).toBeUndefined();
    expect(doc.url).toBeUndefined();
  });
});

describe('renderItem: call / meeting / task', () => {
  it('renders call header fields', () => {
    const doc = one({
      kind: 'calls',
      record: {
        id: '9004',
        properties: { hs_call_title: 'Intro call', hs_call_body: 'Discussed pricing', hs_call_direction: 'OUTBOUND', hs_call_duration: '1800000', hs_timestamp: '2026-02-14T15:00:00Z' },
      },
      assoc: { contacts: ['501'] },
      ctx,
    });
    expect(doc.type).toBe('hubspot.call');
    expect(doc.title).toBe('Intro call');
    expect(doc.markdown).toContain('**Direction:** OUTBOUND');
    expect(doc.markdown).toContain('Discussed pricing');
  });

  it('renders meeting times and both body fields', () => {
    const doc = one({
      kind: 'meetings',
      record: {
        id: '9005',
        properties: { hs_meeting_title: 'QBR', hs_meeting_body: '<p>Agenda</p>', hs_internal_meeting_notes: '<p>Internal: risk</p>', hs_meeting_start_time: '2026-04-01T10:00:00Z', hs_meeting_location: 'Zoom', hs_timestamp: '2026-04-01T10:00:00Z' },
      },
      assoc: {},
      ctx,
    });
    expect(doc.title).toBe('QBR');
    expect(doc.markdown).toContain('**Location:** Zoom');
    expect(doc.markdown).toContain('Agenda');
    expect(doc.markdown).toContain('Internal: risk');
  });

  it('renders task status/priority', () => {
    const doc = one({
      kind: 'tasks',
      record: {
        id: '9006',
        properties: { hs_task_subject: 'Send proposal', hs_task_body: 'v2 with discount', hs_task_status: 'NOT_STARTED', hs_task_priority: 'HIGH', hs_timestamp: '2026-04-02T10:00:00Z' },
      },
      assoc: {},
      ctx,
    });
    expect(doc.title).toBe('Send proposal');
    expect(doc.markdown).toContain('**Status:** NOT_STARTED');
    expect(doc.markdown).toContain('**Priority:** HIGH');
  });
});

describe('renderItem: file', () => {
  it('emits a binary file doc parented to its engagement', () => {
    const doc = one({
      kind: 'file',
      fileId: 'f1',
      filename: 'proposal.pdf',
      mime: 'application/pdf',
      size: 1234,
      bytes: new Uint8Array([1, 2]),
      portalId: '123',
      parent: { externalId: '9002', type: 'hubspot.email' },
      createdAt: '2026-03-03T09:00:00Z',
    });
    expect(doc.type).toBe('file');
    expect(doc.externalId).toBe('f1');
    expect(doc.title).toBe('proposal.pdf');
    expect(doc.url).toBe('https://app.hubspot.com/file-preview/123/file/f1/');
    expect(doc.markdown).toBe(null);
    expect(doc.binary).toEqual({ bytes: new Uint8Array([1, 2]), mime: 'application/pdf', filename: 'proposal.pdf' });
    expect(doc.parent).toEqual({ externalId: '9002', type: 'hubspot.email' });
    expect(doc.metadata.hubspot_file_id).toBe('f1');
  });

  it('oversized file: no binary, extraction_status too_large', () => {
    const doc = one({
      kind: 'file',
      fileId: 'f2',
      filename: 'huge.mov',
      mime: 'video/quicktime',
      size: 99_999_999,
      bytes: null,
      portalId: '123',
      parent: { externalId: '9001', type: 'hubspot.note' },
      createdAt: null,
    });
    expect(doc.binary).toBeUndefined();
    expect(doc.metadata.extraction_status).toBe('too_large');
    // an unextractable file still deep-links into the portal
    expect(doc.url).toBe('https://app.hubspot.com/file-preview/123/file/f2/');
  });
});
