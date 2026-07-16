# HubSpot connector for KIAgent — design

**Date:** 2026-07-16
**Repo:** github.com/kia-plugins/hubspot-kia-connector
**Status:** approved

## Goal

Index a HubSpot portal — full CRM (contacts, companies, deals, tickets) plus the
engagement timeline (emails, notes, calls, meetings, tasks) and engagement file
attachments — into local KIAgent memory, kept in sync incrementally.

## Architecture

A KIAgent Extension Platform plugin, same shape as `notion-kia-connector` and
`slack-kia-connector`: a TypeScript CJS bundle whose default export is
`{ activate(host) }` returning one Source contribution. The platform owns
scheduling, cursor persistence, credential storage, and document commits; the
connector implements `descriptor`, `connect`, `pull`, `toDocument`, and
`fetchBytes`. All HTTP goes through `host.net.fetch` (`net` cap only).

Boilerplate reused byte-identical from the existing connectors: `build.mjs`
(esbuild → `dist/index.js`, cjs, node20), `tsconfig.json`, `jest.config.js`,
`.gitignore`, LICENSE (MIT, Eldar Djafarov), devDeps (esbuild, typescript,
jest, ts-jest), `src/index.ts` activate pattern, bundle-load smoke test.
`src/kiagent-contracts.ts` re-vendored from current kiagent-core
`src/shared/contracts.ts` (record the commit hash in the file header).

Manifest:

```json
{
  "id": "kia.hubspot",
  "name": "HubSpot",
  "version": "0.1.0",
  "engine": "^1.0.0",
  "entry": "dist/index.js",
  "icon": "icon.png",
  "caps": ["net"],
  "contributes": { "sources": ["hubspot"] }
}
```

Source descriptor: `id: 'hubspot'`, `auth: 'password'`,
`cadence: { every: '30m' }`, `multiAccount: true` (one account per portal).

File layout:

```
src/
  index.ts        activate() → { sources: [createHubSpotSource(host)] }
  kiagent-contracts.ts   vendored SDK — do not edit
  client.ts       rate-limited HubSpot API client (structural copy of slack's)
  source.ts       descriptor, connect, pull dispatch, fetchBytes
  backfill.ts     phased backfill generator
  delta.ts        per-type search-based delta generator + archived sweep
  render.ts       pure markdown renderers (objects, engagements, html→text)
  properties.ts   per-type property lists + custom-property discovery
  lookups.ts      owners / pipelines / stages lookup fetch + maps
  types.ts        cursor, item, and HubSpot payload types
  __tests__/      fixtures + unit tests + bundle-load smoke test
```

## Auth & connect

HubSpot **Private App** paste-token flow (`auth: 'password'`):

1. `connect(auth)` prompts with a JSON Schema carrying `x-steps` that walk the
   user through Settings → Integrations → Private Apps → Create, granting
   read-only scopes: `crm.objects.contacts.read`,
   `crm.objects.companies.read`, `crm.objects.deals.read`, `tickets`,
   `crm.objects.owners.read`, `sales-email-read` (email engagement bodies),
   `files` (attachment download). The wizard lists the scopes as a copyable
   block. Exact scope names are confirmed against HubSpot's scope picker
   during implementation; the wizard text is the single place they appear.
2. Local shape check: token must match `^pat-`.
3. Verify via `GET /account-info/v3/details`. This endpoint is mandatory —
   the identifier needs its `portalId`, which no other read endpoint returns —
   so `account-info.security.read` is part of the wizard's required scope
   list, and a 403 produces a clear error naming the missing scope. Auth
   failure → clear error message in the wizard.
4. Return `{ identifier, config }`: identifier = `portal-{portalId}` (the
   API's `uiDomain` is the generic app domain, not portal-specific); config
   stores `{ portalId }` — non-secret, needed for deep links. The platform vaults the token; `pull` reads it back via
   `session.credentials().password`.

## Document model

Nine document types. `externalId` = HubSpot numeric object id (unique per
type; upsert key is (account, externalId, type)). Deep links use
`https://app.hubspot.com/contacts/{portalId}/record/{objectTypeId}/{id}` with
objectTypeIds 0-1 contact, 0-2 company, 0-3 deal, 0-5 ticket.

### CRM objects

| type | title | createdAt |
|---|---|---|
| `hubspot.contact` | "First Last — Company" (fallback email) | `createdate` |
| `hubspot.company` | company name (fallback domain) | `createdate` |
| `hubspot.deal` | deal name | `createdate` |
| `hubspot.ticket` | ticket subject | `createdate` |

Markdown = `# title`, then grouped `**Label:** value` lines for a curated set
of standard properties per type (contact: name, email, phone, mobile, job
title, company, lifecycle stage, lead status, owner, city/state/country,
website; company: name, domain, industry, phone, location, employees, annual
revenue, description, lifecycle stage, owner; deal: name, amount, stage,
pipeline, close date, type, owner, description; ticket: subject, content,
pipeline, stage, priority, owner) **plus all non-empty custom properties**
(discovered once per pull via `GET /crm/v3/properties/{type}`, filtered to
`hubspot_defined: false`). Owner ids render as names, pipeline/stage ids as
labels — resolved at pull start (`/crm/v3/owners`, `/crm/v3/pipelines/deals`,
`/crm/v3/pipelines/tickets`) and attached to the item so `toDocument` stays
pure.

Metadata: `hubspot_object_type`, `owner` (name + email), `lifecycle_stage` /
`pipeline` + `stage` labels where applicable, `last_modified_at`, and
`associations` (map of type → id list).

### Engagements

| type | title | body source | createdAt |
|---|---|---|---|
| `hubspot.email` | `hs_email_subject` | `hs_email_text`, fallback `hs_email_html` → text | `hs_timestamp` |
| `hubspot.note` | first 80 chars of body | `hs_note_body` (HTML) → text | `hs_timestamp` |
| `hubspot.call` | `hs_call_title` (fallback "Call — date") | `hs_call_body` → text; direction, duration in header | `hs_timestamp` |
| `hubspot.meeting` | `hs_meeting_title` | `hs_meeting_body` + `hs_internal_meeting_notes`; start/end/location in header | `hs_timestamp` |
| `hubspot.task` | `hs_task_subject` | `hs_task_body`; status, priority in header | `hs_timestamp` |

HTML bodies converted by a small pure `htmlToText` renderer in `render.ts`
(tags stripped, `<br>/<p>/<li>` → line structure, entities decoded — same
altitude as slack's message rendering, no dependency).

`parent` = primary associated object, priority **contact > deal > ticket >
company** (`{ externalId: id, type: 'hubspot.contact' | … }`). Engine resolves
parents against already-committed rows and degrades to null if missing
(verified: kiagent-core `write-tx.ts`), so ordering objects before engagements
in backfill makes refs resolve; a miss is non-fatal. All associations
(including non-primary) go in metadata. Email metadata additionally carries
direction, from/to (parsed from `hs_email_headers`), and status. `url` = the
primary parent's record page (engagements have no page of their own).

### Attachments

Engagement `hs_attachment_ids` (emails, notes, meetings) become `file` docs:
`externalId` = HubSpot file id, `markdown: null`,
`binary: { bytes, mime, filename }` fetched via
`GET /files/v3/files/{id}` + its signed download URL, `parent` → the
engagement doc, emitted in the same batch. Files > 50 MB: no bytes,
`metadata.extraction_status: 'too_large'`. `fetchBytes(session, doc)`
implemented for re-extraction (looks up the file id from doc metadata,
re-downloads). Signed download URLs are fetched fresh each time, never stored.

## Sync

### Cursor

```ts
type TypeKey = 'companies' | 'contacts' | 'deals' | 'tickets'
             | 'notes' | 'calls' | 'meetings' | 'tasks' | 'emails';

type Cursor =
  | { phase: 'backfill'; step: TypeKey; after: string | null;
      watermarks: Partial<Record<TypeKey, string>>; backfillStartedAt: string }
  | { phase: 'live'; watermarks: Record<TypeKey, string>;
      archiveSweep?: { step: TypeKey; after: string | null } };
```

Every yielded cursor is `structuredClone`d. Each Batch yield is a crash-safe
checkpoint (engine commits items + cursor in one transaction).

### Backfill

Steps in order: companies → contacts → deals → tickets → notes → calls →
meetings → tasks → emails (objects first so engagement parents resolve).
Each step pages `GET /crm/v3/objects/{type}?limit=100&after=…&properties=…&associations=contacts,companies,deals,tickets`;
one Batch per page with `phase: 'backfill'` and `estimateTotal` where
available. Per-type watermark = `backfillStartedAt` (the delta overlap covers
records modified mid-backfill). Ends by yielding a final empty
`{ phase: 'live', watermarks }` batch so delta never sees a backfill cursor.

### Delta (every 30 min)

Per type, `POST /crm/v3/objects/{type}/search`:
filter last-modified ≥ watermark − 5 min overlap (property is
`lastmodifieddate` for contacts, `hs_lastmodifieddate` for everything else;
values in epoch ms), sorted ascending, `limit: 100`. The search API's 10k
result cap is handled by windowing: on hitting it, advance the watermark to
the last record seen and re-issue. Search results don't include associations —
fetched via `POST /crm/v4/associations/{from}/{to}/batch/read` per page.

A per-tick **request budget** (60 API calls, slack's pattern) with
stalest-type-first rotation bounds each poll; unfinished types resume next
tick from their unadvanced watermark. Watermark only advances past records
that were successfully emitted.

### Deletions

No `reconcile()` (a full per-cycle ID listing of a large portal is thousands
of requests — same rationale as slack's omission, documented in a code
comment). Instead each delta tick runs a budgeted **archived sweep**: page
`GET /crm/v3/objects/{type}?archived=true` per type (round-robin position
stored in `cursor.archiveSweep`), emitting `Batch.deletions` refs for archived
ids. Known limitation, stated in the README: GDPR hard-deletes (which vanish
without an archived record) are not detected.

### Rate limiting & errors

`client.ts` copies slack's ladder with HubSpot constants: global throttle
~3 req/s (private-app burst limit is 100–190 per 10 s), search calls
additionally spaced to ≤3 req/s (HubSpot caps search at 5 req/s); 429 →
Retry-After clamped [1, 60] s (default 5 s), ≤5 retries; 5xx/network →
exponential backoff, ≤4 retries; typed `ApiError` tagging 401/403 as auth
errors. Auth errors propagate out of `pull` (platform flips account to
`needsReauth`). Per-record failures (unparseable payload, one failed file
download) → `session.log('warn', …)` + skip without advancing the watermark
past them. `session.signal` checked in every loop; abort → return.

## Testing

TDD throughout. Unit tests with fixtures for: renderers and `toDocument` per
doc type (pure, fixture JSON from real-shaped API payloads); client retry
ladder (429/5xx/network, injectable `sleep`/`now`); backfill step transitions
and cursor shapes against a stubbed `host.net.fetch`; delta windowing incl.
the 10k cap and watermark-advance rules; archived-sweep deletions; connect
validation paths. Bundle-load smoke test (build + require dist, activate with
stub host, assert descriptor id). `npm test`, `npm run typecheck` green before
any merge.

## Packaging & README

`package.json` `files: ["manifest.json", "dist", "README.md", "icon.png"]`,
`private: true`, distributed as `npm pack` `.tgz` GitHub release asset; repo
tagged with topic `kia-plugin` so the marketplace discovers it. README follows
the established section order: title + one-paragraph summary → Install →
Connect your portal (numbered Private-App steps + copyable scope list) → What
gets indexed → Sync behavior (Backfill / Live sync / Deletions, cadence
bolded) → Privacy (standard boilerplate) → Build from source → License (MIT).
Manifest and package.json versions kept in lockstep.
