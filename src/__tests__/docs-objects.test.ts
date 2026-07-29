import { primaryParent, recordUrl, renderItem } from '../docs';
import type { DocumentInput } from '@kiagent/connector-sdk';
import { ctx } from '../testing/fixtures';
import type { HubSpotItem } from '../types';

const one = (item: HubSpotItem): DocumentInput => {
  const out = renderItem(item);
  expect(out).not.toBeNull();
  expect(Array.isArray(out)).toBe(false);
  return out as DocumentInput;
};

describe('renderItem: contact', () => {
  const item: HubSpotItem = {
    kind: 'contacts',
    record: {
      id: '501',
      properties: {
        firstname: 'Jane',
        lastname: 'Doe',
        email: 'jane@acme.com',
        company: 'Acme',
        lifecyclestage: 'customer',
        hubspot_owner_id: '9',
        favorite_color: 'teal',
        createdate: '2025-01-02T03:04:05Z',
        lastmodifieddate: '2026-07-01T00:00:00Z',
      },
      associations: { companies: { results: [{ id: '77', type: 'contact_to_company' }] } },
    },
    assoc: { companies: ['77'] },
    ctx,
  };

  it('builds title, url, markdown, metadata', () => {
    const doc = one(item);
    expect(doc.externalId).toBe('501');
    expect(doc.type).toBe('hubspot.contact');
    expect(doc.title).toBe('Jane Doe — Acme');
    expect(doc.url).toBe('https://app.hubspot.com/contacts/123/record/0-1/501');
    expect(doc.createdAt).toBe('2025-01-02T03:04:05Z');
    expect(doc.markdown).toContain('**Email:** jane@acme.com');
    expect(doc.markdown).toContain('**Owner:** Ada Lovelace');
    expect(doc.markdown).toContain('**Favorite color:** teal'); // custom prop, labeled
    expect(doc.metadata.hubspot_object_type).toBe('contacts');
    expect(doc.metadata.associations).toEqual({ companies: ['77'] });
    expect(doc.metadata.last_modified_at).toBe('2026-07-01T00:00:00Z');
    expect(doc.parent).toBeUndefined(); // objects are roots
  });

  it('falls back to email when nameless', () => {
    const doc = one({ ...item, record: { ...item.record, properties: { ...item.record.properties, firstname: null, lastname: null, company: null } } });
    expect(doc.title).toBe('jane@acme.com');
  });
});

describe('renderItem: deal', () => {
  it('renders stage/pipeline labels, not ids', () => {
    const doc = one({
      kind: 'deals',
      record: {
        id: '88',
        properties: { dealname: 'Acme renewal', amount: '40000', dealstage: 's2', pipeline: 'default', createdate: '2025-05-05T00:00:00Z', hs_lastmodifieddate: '2026-07-02T00:00:00Z' },
      },
      assoc: {},
      ctx,
    });
    expect(doc.type).toBe('hubspot.deal');
    expect(doc.title).toBe('Acme renewal');
    expect(doc.markdown).toContain('**Stage:** Won');
    expect(doc.markdown).toContain('**Pipeline:** Sales');
    expect(doc.url).toBe('https://app.hubspot.com/contacts/123/record/0-3/88');
    expect(doc.metadata.stage).toBe('Won');
  });
});

describe('renderItem: ticket', () => {
  it('renders ticket stage labels', () => {
    const doc = one({
      kind: 'tickets',
      record: { id: '5', properties: { subject: 'Login broken', content: 'cannot sign in', hs_pipeline_stage: 't1', createdate: '2026-01-01T00:00:00Z' } },
      assoc: {},
      ctx,
    });
    expect(doc.type).toBe('hubspot.ticket');
    expect(doc.title).toBe('Login broken');
    expect(doc.markdown).toContain('**Stage:** New');
    expect(doc.markdown).toContain('cannot sign in');
  });
});

describe('primaryParent / recordUrl', () => {
  it('applies contact > deal > ticket > company priority', () => {
    expect(primaryParent({ companies: ['1'], deals: ['2'], contacts: ['3'] })).toEqual({ externalId: '3', type: 'hubspot.contact' });
    expect(primaryParent({ companies: ['1'], tickets: ['4'] })).toEqual({ externalId: '4', type: 'hubspot.ticket' });
    expect(primaryParent({})).toBe(null);
    expect(recordUrl(ctx, 'companies', '77')).toBe('https://app.hubspot.com/contacts/123/record/0-2/77');
  });
});
