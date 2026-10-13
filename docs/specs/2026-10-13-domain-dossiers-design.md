# HubSpot domain dossiers — design

Date: 2026-10-13 · Status: rev 4 — SATISFIED by Fable + Codex astra (nothing built) · Connector: `kia.hubspot` v0.1.7 → v0.2.0
Precedent: `notion-kia-connector/docs/specs/2026-10-13-row-bundles-design.md` (shipped v3.0.0).

## Problem

The founder's portal indexes as **207,072** documents, almost all of them
tiny or machine-generated:

| Type | Docs | What it is |
|---|---|---|
| `hubspot.contact` | 131,840 | Avg 233 chars, 86 % < 300. ~91k touched by one July-2026 lead import. Only 13.7k have any activity. |
| `hubspot.email` | 49,883 | 48,762 **outbound** sequence sends: one sender has 7,978 sends but 839 distinct subjects, so these are templates. Only 1,121 **incoming** replies (~200 contacts). |
| `hubspot.task` | 9,916 | ≈ 9.8k LinkedIn automation steps ("Visit Profile", "Connect", …) |
| `hubspot.company` | 9,423 | company records (`Domain`, industry, size…) |
| `hubspot.meeting` / `deal` / `note` / `ticket` | 3,409 / 1,147 / 883 / 1 | real CRM substance |
| `file` | 570 | engagement attachments |

Only 21k contacts are associated with a HubSpot company. Their **email
domains**, though, are corporate:
- 26.8k distinct domains in all;
- 633 domains with more than 20 contacts hold 71.8k contacts (nike.com 2,226, adidas.com 1,625, amazon.com 1,487, …);
- gmail.com alone has 17.9k contacts.

## Goal

Consolidate contacts, companies and outbound automation into **bounded,
non-intersecting dossier documents grouped by organisation** (email
domain). Every such HubSpot item lands in exactly one live document, and
documents stay small enough for full-text search (core: one FTS5 row per
document, ANDed terms, ~24-token snippets, no chunking).

Real conversation (incoming replies, notes, meetings, calls, deals,
tickets, files) stays as individual documents with their own sender, date
and deep link.

Non-goals: semantic clustering, summarisation, changing deals and tickets
(the Messages page lists them as items).

## Constraints

Shared with the Notion design and verified in core:
- one-item batch = atomic;
- upserts are applied before deletions;
- deleting an unknown ref is a no-op;
- the cursor is the only durable connector state;
- archiving a doc also archives its live children (`write-tx.ts` `archiveChildren`), and a `parent` ref to an unknown doc resolves to none.

Notion's pattern was to list everything every 30 minutes. That doesn't
transplant here: a full listing is about 2k requests. HubSpot also has no
documented guarantee that changing an engagement's associations bumps
`hs_lastmodifieddate`, so incremental change detection can't see moves.

**Consumers** (verified in the alpha-cent and kiagent-core `dev` branches):
- No app feature reads `hubspot.contact`, `hubspot.company`, `hubspot.email`
  or `hubspot.task`.
- The Messages page lists only `hubspot.deal` and `hubspot.ticket`
  (`contracts/messages.ts`).
- People reads `email.*` and `calendar.event` only.
- Search is the only consumer:
  - `from:`/`to:`/`participant:` match `metadata.from/to/participants`;
  - date filters use the document's `created_at`;
  - `get_related` follows `parent`.

## Design

### 1. Two sync paths, split by type

| Path | Owns | Cadence |
|---|---|---|
| **Incremental** (today's delta, backfill and archived sweep) | `deals`, `tickets`, `notes`, `calls`, `meetings`, **incoming** emails (`hs_email_direction` ≠ `EMAIL`), outbound emails **with attachments** (`hs_attachment_ids` non-empty) and their `file` docs | every 30 min |
| **Dossier pass** (new) | `contacts`, `companies`, `tasks`, outbound emails without attachments | full rebuild every `DOSSIER_EVERY` = 6 h |

Changes to the incremental path:
- Delta and backfill stop emitting what the pass owns, and drop pass-owned records **before** the association batch-read (`delta.ts` ~434), so sequence sends don't eat the 60-request tick budget.
- The archived sweep drops contacts, companies and tasks. It keeps emails,
  because it is the only place archived emails' `file` children get deleted.
  An archived *folded* email's ref doesn't exist as a doc, so that delete is a no-op.
- Attached outbound emails stay standalone because their `file` docs parent
  on `hubspot.email|id`.
  Folding them too was considered and rejected: files would need parentless
  docs plus tracked file lifetimes (more state) to save about 1% of emails. If an
  email's attachment status flips, it's healed within one pass (§4 folded-ref
  deletion, and the pass skips attached emails).

**Freshness trade-off:** a new lead, sequence send or LinkedIn task is
searchable within ≤ 6 h plus the pass duration. Replies, notes, meetings and
deals stay at ≤ 30 min.

**Parents.** Standalone engagements get **no `parent`**.
- Today they parent on a contact (and could parent on a deal). Archiving or
  merging that record archives them via `archiveChildren`, and nothing
  restores them.
- Their associated deal, ticket, contact and company ids go into
  `metadata.associations`, with deep links in the body.
- Only `file → email` parenting remains. That cascade is wanted.
- This also removes `PARENT_PRIORITY` and the "objects before engagements"
  backfill ordering.

### 2. Scope key (which dossier an item belongs to)

"In the index" means the item was returned by this pass's live listings (§4).

- **Company.** A non-public normalised `domain` → `dom:<domain>`. Otherwise
  → `co:<companyId>`.
- **Contact.** Let `d` be the domain of the `email` property.
  1. `d` present and not public → `dom:<d>`.
  2. Else, take the associated company in the index with the smallest id and
     use its scope key (`dom:` or `co:`).
  3. Else → `ind:<YYYY-MM>`, using the UTC month of `createdate`.
- **Folded engagement** (task, or outbound email without attachments):
  - its owner is the associated contact in the index with the smallest id;
  - else the associated company in the index with the smallest id;
  - it renders inside its owner's section;
  - with no owner it goes to `orphan:<YYYY-MM>` (UTC month of
    `hs_timestamp`), so every pass-owned item lives in some scope.

`PUBLIC_DOMAINS` is a copy of alpha-cent's
`extensions/people/src/rules/public-domains.ts` list.

Domain normalisation: lowercase, trim, strip a leading `www.`, take the host
of a URL-shaped value.

### 3. Layout

Each scope's content is a sequence of **blocks**:
- company sections first, by id;
- then contact sections, by `(createdate, id)`. Each contact header block is
  followed by one block per folded engagement, by `(hs_timestamp, id)`;
- orphan scopes hold only engagement blocks.

**Block bound.** Every rendered block, of any type, is capped at
`BLOCK_MAX` = 6,000 chars:
- its first line (name or subject + record link) is always kept;
- the tail is cut with `… [truncated — open in HubSpot]`.

Folded email bodies are additionally cut at `FOLD_BODY_MAX` = 4,000 chars.
Only 519 of 49.9k emails exceed 8k today, and those are templates.

`BLOCK_MAX` + the part header + one continuation header < `PART_MAX_CHARS`,
so every part is ≤ 8,000 chars.

Blocks are packed greedily into parts of ≤ `PART_MAX_CHARS` = 8,000 chars,
counting full rendered length plus the part header. A contact whose
activity continues into the next part repeats a one-line
`## <name> (cont.)` header.

Part id: `hubspot-dossier:<scopeKey>:<i>`, type `hubspot.dossier`.

```
# Nike (nike.com) — part 2
Organisation: nike.com · part 2

## Company: Nike · [open](…/record/0-2/123)
**Industry:** … (the company's existing rendered properties)

## Jane Doe — Director of eCommerce · [open](…/record/0-1/456)
**Email:** jane@nike.com · **Lifecycle stage:** lead · **Owner:** Daniel Suchi
- 2025-07-09 · Email sent (daniel@gripsintel.com) · "Re: Are you tracking competitors?"
  <body, ≤ 4,000 chars>
- 2025-07-12 · Task · LinkedIn: Visit Profile · COMPLETED
```

| Field | Value |
|---|---|
| `title` | `<company name> (<domain>)` if exactly one company record is in scope; else the domain / "Individuals — YYYY-MM" / "Unassigned activity — YYYY-MM". Suffix ` — part i` for i > 1. No totals or counts appear anywhere in a part (title, body or metadata), so an unchanged part keeps its `contentHash` and isn't rewritten when its scope grows. |
| `url` | the company record if exactly one; else the first contact's or engagement's record |
| `createdAt` | the latest record or activity timestamp in the part |
| `metadata` | `{ scope, domain?, part, contactIds, companyIds, engagementIds, participants: [contact emails] }` |
| `parent` | none |

### 4. The dossier pass

**When.** Inside `pull`, after the incremental step, if both hold:
- `now − dossier.lastCompletedAt ≥ DOSSIER_EVERY` (or it never ran);
- `now − dossier.attemptedAt ≥ DOSSIER_RETRY` (= 1 h).

`attemptedAt` is committed (cursor-only batch) when a pass starts. A pass
that aborts (sleep, quit, error) is simply redone from scratch at the next
attempt. It isn't resumable. The retry floor caps the waste at ≤ 24 aborted
passes a day.

**1. List (render while listing).** One paginated list per type with
rendering properties and associations inline (`GET
/crm/v3/objects/{type}?properties=…&associations=…`, 100 per page):
- contacts and companies;
- tasks;
- emails (incoming and attached ones are skipped client-side).

Each record is rendered into its block immediately. Only `{ scope inputs,
block string }` is kept. There is no second fetch stage.

| | |
|---|---|
| Requests | ≈ 1.3k + 0.1k + 0.1k + 0.5k ≈ **2k** |
| Time | ≈ 11 min at the client's global 3 rps throttle |
| Peak memory | ≈ 90 MB of block strings for this portal (measured average sizes × counts) |

Pagination of these listings never uses search, so it has no 10k cap.

**2. Group, pack, emit.**
- Compute scopes and owners, and pack every scope (sorted by scope key).
- Cut the ordered sequence of parts into chunks of ≤ `CHUNK_MAX_BYTES` = 2 MB.
  A big scope (e.g. `ind:2026-07`) spans several chunks.
- Each chunk is **one item** (`toDocument` returns its parts). One item per
  batch commits atomically, since the engine splits only between items.
- The chunk's batch carries:
  - `deletions`: the `hubspot.email|id` ref of every folded email in the
    chunk. That's a no-op unless the email used to be standalone (e.g. its
    attachment was removed), so no email lives in two docs.
  - `cursor`: the prior cursor with
    `dossier.scopes[key] = max(hi, parts written so far)` for each scope in
    the chunk, where `hi` is the previously stored value.

  So `dossier.scopes[key]` is always ≥ the highest part index ever
  committed, and a crash between chunks can't strand a part.
- **Final batch** (no items):
  - `deletions`:
    - per scope, the stale trailing parts `newP .. hi-1`;
    - every part of every scope in `dossier.scopes` that the index no
      longer has;
  - `cursor`: `scopes[key] = newP`, vanished keys dropped,
    `lastCompletedAt = now`, and `counts` (live records per listed type).

  Stale parts linger until the pass completes. That's an accepted
  transient, the same as a crashed pass.
- **Shrink guard.** A listing that ends early (no `paging.next` on a bad
  page) looks complete. If any type's count is < 50 % of
  `dossier.counts[type]` from the last completed pass:
  - the final batch skips its deletions and `lastCompletedAt`, commits only
    `attemptedAt`, and logs a warning;
  - the next attempt (≥ 1 h) retries.

**Cursor.**
`v: 2` on **every** cursor shape (backfill phase, live, sweep), plus `dossier: { lastCompletedAt: string | null; attemptedAt: string | null; scopes: Record<string, number>; counts: Record<string, number> }`
(scope → part count, ≈ 30k entries ≈ 600 KB). Written once per chunk,
≈ 50 writes per pass.

**Cursor preservation (all paths).** Every cursor the connector yields,
including those from delta, backfill, the live flip and the archived sweep,
is built as `{ ...latestCursor, <changed fields> }`. The pass starts from the
incremental step's final cursor. Today's code builds fresh cursor literals,
and this must change. A dropped `dossier` would re-run the pass every tick
and forget stale parts.

### 5. Search behaviour changes (accepted)

- `from:`/`to:` on outbound sequence emails match the dossier only through
  `participants` (contact emails), not the sender. Incoming replies keep
  exact `from`/`to`.
- A date filter matches a dossier part by its latest activity, not each send.
- Contacts and companies have no document of their own. `get_related` of a
  note or meeting reaches its deal, not its contact. The dossier part is the
  unit.

### 6. Migration: remove and re-add the account

Same as Notion v3.0.0. The upgrade is **remove the HubSpot account, update
via Marketplace, re-add**.

In-place retirement is unsafe: deleting a v0.1 `hubspot.contact|id`
archives its children (`write-tx.ts` `archiveChildren`), and today every
note, meeting and incoming reply parents on its contact. They would vanish
and never come back.

The connector refuses a non-v0.2 cursor. A non-null cursor without `v: 2`
throws `SourcePermanentError('Remove and re-add the HubSpot account to
upgrade to dossiers')`, which gives an error status and no retries.

Treating it as `null` would re-backfill, but leave 141k v0.1 contact and
company docs live forever: nothing in v0.2 deletes those refs. The README
states the step. Test: a fresh v0.2 account whose backfill is interrupted after page 1 resumes without the permanent error.

Expected corpus:
- ≈ 30k dossier parts;
- plus ≈ 6.5k standalone docs (replies, notes, meetings, calls, deals,
  attached emails, files);
- **≈ 37k in all, down from 207k**.

## Deferred

- Summaries or a "last touch" header per contact.
- De-duplicating identical template bodies.
- Incremental dossier updates between passes.
- v0.1 inherited: a file removed from an email that stays standalone isn't deleted (no per-engagement attachment membership is tracked).
- Resumable passes (persisting pass progress) — only if aborted-pass waste shows up.

## Open questions

1. `DOSSIER_EVERY` = 6 h vs 24 h.
2. Should outbound **1:1** (non-sequence) emails stay standalone? There's no
   reliable documented property to tell them apart, so v1 folds every
   outbound email without attachments.
