import type { ExternalRef } from './kiagent-contracts';

export const OBJECT_TYPES = ['companies', 'contacts', 'deals', 'tickets'] as const;
export const ENGAGEMENT_TYPES = ['notes', 'calls', 'meetings', 'tasks', 'emails'] as const;
export const ALL_TYPES = [...OBJECT_TYPES, ...ENGAGEMENT_TYPES] as const;

export type ObjectTypeKey = (typeof OBJECT_TYPES)[number];
export type EngagementTypeKey = (typeof ENGAGEMENT_TYPES)[number];
export type TypeKey = (typeof ALL_TYPES)[number];

export const DOC_TYPE: Record<TypeKey, string> = {
  companies: 'hubspot.company',
  contacts: 'hubspot.contact',
  deals: 'hubspot.deal',
  tickets: 'hubspot.ticket',
  notes: 'hubspot.note',
  calls: 'hubspot.call',
  meetings: 'hubspot.meeting',
  tasks: 'hubspot.task',
  emails: 'hubspot.email',
};

/** HubSpot's numeric objectTypeIds — used for record deep links. */
export const OBJECT_TYPE_ID: Record<ObjectTypeKey, string> = {
  contacts: '0-1',
  companies: '0-2',
  deals: '0-3',
  tickets: '0-5',
};

/** Contacts alone use `lastmodifieddate`; every other type `hs_lastmodifieddate`. */
export const LAST_MODIFIED_PROP: Record<TypeKey, string> = {
  contacts: 'lastmodifieddate',
  companies: 'hs_lastmodifieddate',
  deals: 'hs_lastmodifieddate',
  tickets: 'hs_lastmodifieddate',
  notes: 'hs_lastmodifieddate',
  calls: 'hs_lastmodifieddate',
  meetings: 'hs_lastmodifieddate',
  tasks: 'hs_lastmodifieddate',
  emails: 'hs_lastmodifieddate',
};

/** One CRM record as the v3 API returns it. */
export interface HubSpotRecord {
  id: string;
  properties: Record<string, string | null>;
  createdAt?: string;
  updatedAt?: string;
  archived?: boolean;
  associations?: Record<string, { results: Array<{ id: string; type: string }> }>;
}

/** Associated object ids, keyed by object type. */
export type Associations = Partial<Record<ObjectTypeKey, string[]>>;

/** Pull-time lookups attached to every item so toDocument stays PURE. */
export interface RenderContext {
  portalId: string;
  owners: Record<string, { name: string; email?: string }>;
  /** deal stage id → labels */
  dealStages: Record<string, { pipeline: string; stage: string }>;
  /** ticket stage id → labels */
  ticketStages: Record<string, { pipeline: string; stage: string }>;
  /** per type: custom property name → human label */
  customProps: Partial<Record<TypeKey, Record<string, string>>>;
}

export type HubSpotItem =
  | { kind: TypeKey; record: HubSpotRecord; assoc: Associations; ctx: RenderContext }
  | {
      kind: 'file';
      fileId: string;
      filename: string;
      mime: string;
      size: number;
      /** File content; null when the file exceeds MAX_FILE_BYTES (rendered as extraction_status 'too_large'). Download failures are logged and the item skipped upstream. */
      bytes: Uint8Array | null;
      parent: ExternalRef;
      createdAt: string | null;
    };

export type HubSpotCursor =
  | {
      phase: 'backfill';
      step: TypeKey;
      after: string | null;
      watermarks: Partial<Record<TypeKey, string>>;
      backfillStartedAt: string;
    }
  | {
      phase: 'live';
      watermarks: Record<TypeKey, string>;
      /** Round-robin resume position of the archived-listing sweep. */
      archiveSweep?: { step: TypeKey; after: string | null };
    };

export interface ListEnvelope {
  results?: HubSpotRecord[];
  paging?: { next?: { after?: string } };
}

export interface SearchEnvelope extends ListEnvelope {
  total?: number;
}
