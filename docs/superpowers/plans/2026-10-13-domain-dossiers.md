# HubSpot Domain Dossiers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapse the HubSpot index from ~207k tiny docs to ~37k by folding contacts, companies, outbound sequence emails and tasks into bounded per-organisation `hubspot.dossier` parts. Real conversation stays as standalone, parentless docs.

**Architecture:**
- **Two paths.**
  - The incremental path (today's backfill, delta and archived sweep) is narrowed to deals, tickets, notes, calls, meetings and incoming/attached emails.
  - A new **dossier pass** lists contacts, companies, tasks and emails every 6 h. It renders blocks while listing, groups them by scope key (email domain / company / month bucket) and packs them into ≤ 8,000-char parts. It emits ≤ 2 MB chunks, one item per batch.
- **Cursor state.** A per-scope part-count high-water map in the cursor drives stale-part deletion in the pass's final batch.

**Tech Stack:**
- TypeScript, Jest (ts-jest, `diagnostics: false`), esbuild;
- `@kiagent/connector-sdk` 1.3.0 (`Source`, `Batch`, `DocumentInput`, `SourcePermanentError`);
- HubSpot CRM v3 list/search, v4 association batch read.

**Spec:** `docs/specs/2026-10-13-domain-dossiers-design.md` (rev 4, SATISFIED by Fable + Codex astra). Read it before Task 1. It is the binding authority.

## Global Constraints

- Cursor version: every cursor shape carries `v: 2`. A non-null cursor without `v: 2` throws `SourcePermanentError('Remove and re-add the HubSpot account to upgrade to dossiers')`.
- Incremental types: `deals`, `tickets`, `notes`, `calls`, `meetings`, `emails`.
  - Emails are incremental only when `hs_email_direction !== 'EMAIL'` **or** `hs_attachment_ids` is non-empty.
- Pass-owned: `contacts`, `companies`, `tasks`, and emails with `hs_email_direction === 'EMAIL'` and empty `hs_attachment_ids`.
- Standalone engagements have **no `parent`**. Only `file → email|note|meeting` parenting remains.
- Dossier doc type `hubspot.dossier`, part id `hubspot-dossier:<scopeKey>:<i>` (i 0-based).
- Size and pacing constants:

  | Constant | Value |
  |---|---|
  | `PART_MAX_CHARS` | 8,000 |
  | `BLOCK_MAX` | 6,000 |
  | `FOLD_BODY_MAX` | 4,000 |
  | `CHUNK_MAX_CHARS` | 2,000,000 |
  | `DOSSIER_EVERY` | 6 h |
  | `DOSSIER_RETRY` | 1 h |
  | Shrink guard | any pass type's listed count < 50 % of the previous completed pass's count |

- Truncation marker: `… [truncated — open in HubSpot]`.
- No totals or counts anywhere in a part (title, body, metadata). Only `part i` (1-based display, shown for i > 0).
- Every cursor the delta and the sweep yield is `{ ...inputCursor, <changed fields> }`, so `dossier` survives.
- `PUBLIC_DOMAINS` is a verbatim copy of alpha-cent `origin/dev:extensions/people/src/rules/public-domains.ts` `PUBLIC_DOMAINS`.
- Commit messages: no `Co-Authored-By` lines. Never amend, rebase, reset or stash.
- Version 0.2.0 in `manifest.json`, `package.json` and `package-lock.json`.

## Review Focus

1. **A crash between two chunks of one big scope.** `dossier.scopes[key]` must already cover every committed part, so the next pass deletes them if the scope shrank. Pinned in Task 6: "high-water map covers parts of an interrupted multi-chunk scope".
2. **A listing that ends early.** The shrink guard must skip the final deletions and `lastCompletedAt`. Pinned in Task 6: "shrink guard skips deletions".
3. **A fresh v0.2 account whose backfill is interrupted after page 1.** The resume must not throw the permanent error. Pinned in Task 7: "resumes an interrupted v2 backfill".
4. **Delta/sweep cursors dropping `dossier`.** Every yielded live cursor keeps `dossier`. Pinned in Task 3: "delta and sweep preserve dossier state".
5. **One huge record (company description, email body, 2,000-char name).** No part exceeds 8,000 chars. Pinned in Task 5: "no part exceeds PART_MAX_CHARS even with oversized blocks".

---

## File Structure

| File | Responsibility |
|---|---|
| `src/types.ts` (modify) | type lists, `INCREMENTAL_TYPES`, `PASS_TYPES`, v2 cursor, `DossierState`, dossier item |
| `src/ownership.ts` (create) | `isPassOwnedEmail` |
| `src/dossier/domains.ts` (create) | `PUBLIC_DOMAINS`, `normalizeDomain`, `emailDomain`, `isPublicDomain` |
| `src/docs.ts` (modify) | parentless engagements + `**Related:**` links; export `parseEmailHeaders`; dossier item passthrough |
| `src/backfill.ts`, `src/delta.ts` (modify) | narrowed to incremental types; filter pass-owned emails before association reads; v2 cursors; spread cursor |
| `src/dossier/blocks.ts` (create) | per-record block rendering + caps (`BLOCK_MAX`, `FOLD_BODY_MAX`) |
| `src/dossier/scope.ts` (create) | index row types, `assignScopes` (pure) |
| `src/dossier/layout.ts` (create) | `layoutScope` → parts (pure) |
| `src/dossier/pass.ts` (create) | `isPassDue`, `dossierPass` generator |
| `src/source.ts` (modify) | version gate, latest-cursor tracking, run pass, descriptor |
| `README.md`, `manifest.json`, `package.json`, `package-lock.json` | docs + 0.2.0 |

Test command for the whole suite: `npx jest 2>&1 | tail -25` plus `npx tsc --noEmit`.

---

### Task 1: Types, cursor v2, ownership and domains

**Files:**
- Modify: `src/types.ts`
- Create: `src/ownership.ts`, `src/dossier/domains.ts`
- Test: `src/__tests__/ownership.test.ts`, `src/__tests__/domains.test.ts`

**Interfaces:**
- Produces:
  - `INCREMENTAL_TYPES`, `IncrementalTypeKey`, `PASS_TYPES`, `PassTypeKey`, `CURSOR_VERSION = 2`;
  - `DossierState { lastCompletedAt: string|null; attemptedAt: string|null; scopes: Record<string,number>; counts: Partial<Record<PassTypeKey,number>> }`;
  - `HubSpotCursor` (v2 union); `LiveCursor`;
  - `HubSpotItem` gains `{ kind: 'dossier'; docs: DocumentInput[] }`;
  - `isPassOwnedEmail(record: HubSpotRecord): boolean`;
  - `normalizeDomain(raw): string|null`, `emailDomain(email): string|null`, `isPublicDomain(d): boolean`, `PUBLIC_DOMAINS`.

- [ ] **Step 1: Write the failing tests**

`src/__tests__/ownership.test.ts`:
```ts
import { isPassOwnedEmail } from '../ownership';

const rec = (props: Record<string, string | null>) => ({ id: '1', properties: props });

describe('isPassOwnedEmail', () => {
  it('owns outbound emails without attachments', () => {
    expect(isPassOwnedEmail(rec({ hs_email_direction: 'EMAIL', hs_attachment_ids: null }))).toBe(true);
    expect(isPassOwnedEmail(rec({ hs_email_direction: 'EMAIL', hs_attachment_ids: ' ' }))).toBe(true);
  });
  it('leaves incoming, forwarded and attached emails to the incremental path', () => {
    expect(isPassOwnedEmail(rec({ hs_email_direction: 'INCOMING_EMAIL' }))).toBe(false);
    expect(isPassOwnedEmail(rec({ hs_email_direction: 'FORWARDED_EMAIL' }))).toBe(false);
    expect(isPassOwnedEmail(rec({ hs_email_direction: 'EMAIL', hs_attachment_ids: '42' }))).toBe(false);
    expect(isPassOwnedEmail(rec({}))).toBe(false);
  });
});
```

`src/__tests__/domains.test.ts`:
```ts
import { emailDomain, isPublicDomain, normalizeDomain } from '../dossier/domains';

describe('normalizeDomain', () => {
  it.each([
    ['Nike.com', 'nike.com'],
    ['  www.nike.com ', 'nike.com'],
    ['https://www.Nike.com/en/shop?x=1', 'nike.com'],
    ['nike.com:443', 'nike.com'],
    ['nike.com.', 'nike.com'],
  ])('%s → %s', (raw, want) => expect(normalizeDomain(raw)).toBe(want));
  it.each([[null], [''], ['   '], ['localhost'], [undefined]])('%s → null', (raw) =>
    expect(normalizeDomain(raw as string | null)).toBeNull(),
  );
});

describe('emailDomain', () => {
  it('takes the part after the last @', () => expect(emailDomain('Jane.Doe@Nike.COM')).toBe('nike.com'));
  it('is null without an @ or domain', () => {
    expect(emailDomain('jane')).toBeNull();
    expect(emailDomain(null)).toBeNull();
    expect(emailDomain('jane@')).toBeNull();
  });
});

describe('isPublicDomain', () => {
  it('knows webmail', () => {
    expect(isPublicDomain('gmail.com')).toBe(true);
    expect(isPublicDomain('gmx.de')).toBe(true);
    expect(isPublicDomain('nike.com')).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx jest src/__tests__/ownership.test.ts src/__tests__/domains.test.ts 2>&1 | tail -15`
Expected: FAIL — `Cannot find module '../ownership'` / `'../dossier/domains'`.

- [ ] **Step 3: Implement**

`src/ownership.ts`:
```ts
import type { HubSpotRecord } from './types';

/** Spec §1: outbound (`EMAIL`) sends without attachments belong to the
 *  dossier pass; incoming/forwarded replies and attached sends stay
 *  standalone on the incremental path (their file docs parent on them). */
export function isPassOwnedEmail(record: HubSpotRecord): boolean {
  const p = record.properties ?? {};
  return p.hs_email_direction === 'EMAIL' && !(p.hs_attachment_ids ?? '').trim();
}
```

`src/dossier/domains.ts`: copy `PUBLIC_DOMAINS` verbatim. Get it with `git -C /Users/edjafarov/work/alpha-cent show origin/dev:extensions/people/src/rules/public-domains.ts`, taking only the `PUBLIC_DOMAINS` set, not `MAIL_INFRA_DOMAINS`. Then:
```ts
/** Copied from alpha-cent extensions/people/src/rules/public-domains.ts
 *  (origin/dev) — webmail domains never name an organisation. */
export const PUBLIC_DOMAINS: ReadonlySet<string> = new Set([
  /* … the verbatim list … */
]);

export function isPublicDomain(domain: string): boolean {
  return PUBLIC_DOMAINS.has(domain.toLowerCase());
}

/** Lowercase, trim, take the host of a URL-shaped value, strip `www.`,
 *  a port and a trailing dot. Null unless it still looks like a domain. */
export function normalizeDomain(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let s = raw.trim().toLowerCase();
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  s = s.split(/[/?#]/)[0] ?? '';
  s = s.replace(/:\d+$/, '').replace(/^www\./, '').replace(/\.$/, '');
  return s.includes('.') ? s : null;
}

export function emailDomain(email: string | null | undefined): string | null {
  if (!email) return null;
  const at = email.lastIndexOf('@');
  return at < 0 ? null : normalizeDomain(email.slice(at + 1));
}
```

`src/types.ts`: add after `ALL_TYPES`:
```ts
/** Spec §1: what the 30-minute incremental path (backfill, delta, archived
 *  sweep) owns. Emails here are filtered by `isPassOwnedEmail`. */
export const INCREMENTAL_TYPES = ['deals', 'tickets', 'notes', 'calls', 'meetings', 'emails'] as const;
export type IncrementalTypeKey = (typeof INCREMENTAL_TYPES)[number];
/** What the dossier pass lists. */
export const PASS_TYPES = ['companies', 'contacts', 'tasks', 'emails'] as const;
export type PassTypeKey = (typeof PASS_TYPES)[number];

export const CURSOR_VERSION = 2 as const;
```
Add `import type { DocumentInput, ExternalRef } from '@kiagent/connector-sdk';` (replacing the `ExternalRef`-only import). Extend `HubSpotItem` with a third member:
```ts
  | { kind: 'dossier'; docs: DocumentInput[] };
```
Replace `HubSpotCursor` with:
```ts
export interface DossierState {
  lastCompletedAt: string | null;
  attemptedAt: string | null;
  /** scope key → part-count high-water mark: always ≥ (highest committed part index + 1). */
  scopes: Record<string, number>;
  /** Records listed per type by the last completed pass — the shrink guard's baseline. */
  counts: Partial<Record<PassTypeKey, number>>;
}

export type HubSpotCursor =
  | {
      v: 2;
      phase: 'backfill';
      step: IncrementalTypeKey;
      after: string | null;
      watermarks: Partial<Record<IncrementalTypeKey, string>>;
      backfillStartedAt: string;
    }
  | {
      v: 2;
      phase: 'live';
      watermarks: Record<IncrementalTypeKey, string>;
      /** Round-robin resume position of the archived-listing sweep. */
      archiveSweep?: { step: IncrementalTypeKey; after: string | null };
      dossier?: DossierState;
    };

export type LiveCursor = Extract<HubSpotCursor, { phase: 'live' }>;
```

- [ ] **Step 4: Run to verify they pass**

Run: `npx jest src/__tests__/ownership.test.ts src/__tests__/domains.test.ts 2>&1 | tail -15`
Expected: PASS (2 suites). `tsc` errors elsewhere are expected until Task 3 (jest runs with `diagnostics: false`).

- [ ] **Step 5: Commit**

```bash
git add src/types.ts src/ownership.ts src/dossier/domains.ts src/__tests__/ownership.test.ts src/__tests__/domains.test.ts
git commit -m "feat(dossier): v2 cursor types, pass ownership, domain normalisation"
```

---

### Task 2: Parentless engagements with related links

**Files:**
- Modify: `src/docs.ts`
- Test: `src/__tests__/docs-engagements.test.ts`

**Interfaces:**
- Consumes: `HubSpotItem` dossier member (Task 1).
- Produces:
  - `relatedLine(assoc: Associations, ctx: RenderContext): string`;
  - exported `parseEmailHeaders(raw: string|null): { from: string|null; to: string[] }`;
  - `renderItem` returns `item.docs` for `kind: 'dossier'`.

- [ ] **Step 1: Write the failing tests**

In `src/__tests__/docs-engagements.test.ts`:
- line 22: replace `expect(doc.parent).toEqual({ externalId: '501', type: 'hubspot.contact' });` with
  ```ts
  expect(doc.parent).toBeUndefined();
  expect(doc.markdown).toContain('**Related:** [contact 501](https://app.hubspot.com/contacts/');
  ```
  Rename that test to `'converts the HTML body, has no parent, links related records'`.
- line 57: replace `expect(doc.parent).toEqual({ externalId: '88', type: 'hubspot.deal' });` with `expect(doc.parent).toBeUndefined();`.
- Leave the `file` tests (lines 127–166) untouched: files still parent on their engagement.

Append:
```ts
describe('dossier item', () => {
  it('passes pre-rendered parts through', () => {
    const docs = [{ externalId: 'hubspot-dossier:dom:x.co:0', type: 'hubspot.dossier', title: 't', markdown: 'm', metadata: {}, createdAt: null }];
    expect(renderItem({ kind: 'dossier', docs })).toBe(docs);
  });
});

describe('relatedLine', () => {
  it('lists at most 10 links, contacts first', () => {
    const assoc = { contacts: Array.from({ length: 12 }, (_, i) => String(i)), deals: ['d1'] };
    const line = relatedLine(assoc, ctx);
    expect(line.startsWith('**Related:** [contact 0](')).toBe(true);
    expect(line.match(/\]\(/g)).toHaveLength(10);
    expect(line).not.toContain('deal d1');
  });
  it('is empty without associations', () => expect(relatedLine({}, ctx)).toBe(''));
});
```
Add `relatedLine` to the file's import from `'../docs'`. Check the existing import of `ctx` (the file imports fixtures; reuse whatever name it uses for the RenderContext).

- [ ] **Step 2: Run to verify they fail**

Run: `npx jest src/__tests__/docs-engagements.test.ts 2>&1 | tail -20`
Expected: FAIL — `relatedLine is not a function`, and `parent` assertions receive objects.

- [ ] **Step 3: Implement** in `src/docs.ts`
- Replace `PARENT_PRIORITY`/`primaryParent` with:
  ```ts
  /** Engagements link (url only — never `parent`: archiving a parent archives
   *  its children, spec §1) to their most specific associated record. */
  const LINK_PRIORITY: ObjectTypeKey[] = ['contacts', 'deals', 'tickets', 'companies'];
  const LINK_LABEL: Record<ObjectTypeKey, string> = { contacts: 'contact', deals: 'deal', tickets: 'ticket', companies: 'company' };
  const MAX_RELATED = 10;

  function primaryLink(assoc: Associations): { type: ObjectTypeKey; id: string } | null {
    for (const t of LINK_PRIORITY) {
      const id = assoc[t]?.[0];
      if (id) return { type: t, id };
    }
    return null;
  }

  export function relatedLine(assoc: Associations, ctx: RenderContext): string {
    const links = LINK_PRIORITY.flatMap((t) =>
      (assoc[t] ?? []).map((id) => `[${LINK_LABEL[t]} ${id}](${recordUrl(ctx, t, id)})`),
    ).slice(0, MAX_RELATED);
    return links.length ? `**Related:** ${links.join(', ')}` : '';
  }
  ```
- In `engagementDoc`:
  - replace `const parent = primaryParent(assoc);` with `const link = primaryLink(assoc);`;
  - replace the markdown line with `const markdown = [`# ${title}`, header, relatedLine(assoc, ctx), body].filter(Boolean).join('\n\n');`;
  - replace the `parentUrl` computation with `const parentUrl = link ? recordUrl(ctx, link.type, link.id) : undefined;`;
  - delete `...(parent ? { parent } : {})` from the returned object.
- Export `parseEmailHeaders` (add `export`).
- In `renderItem`, first line of the function: `if (item.kind === 'dossier') return item.docs;`.
- Remove the now-unused `ExternalRef` import if `tsc` flags it.

- [ ] **Step 4: Run to verify they pass**

Run: `npx jest src/__tests__/docs-engagements.test.ts src/__tests__/docs-objects.test.ts 2>&1 | tail -15`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/docs.ts src/__tests__/docs-engagements.test.ts
git commit -m "feat(docs): parentless engagements with related-record links"
```

---

### Task 3: Narrow the incremental path, v2 cursors, cursor preservation

**Files:**
- Modify: `src/backfill.ts`, `src/delta.ts`
- Test: `src/__tests__/backfill.test.ts`, `src/__tests__/delta.test.ts`, `src/__tests__/archived-sweep.test.ts`

**Interfaces:**
- Consumes: `INCREMENTAL_TYPES`, `IncrementalTypeKey`, `LiveCursor`, `isPassOwnedEmail` (Task 1).
- Produces:
  - `backfill(...)` yields only incremental types; every cursor has `v: 2`;
  - `delta(client, session, cursor: LiveCursor, ctx)` yields cursors `{ ...cursor, watermarks, archiveSweep }` (keeps `dossier`).

- [ ] **Step 1: Update existing tests to the narrowed type set, then add new ones**

`src/__tests__/backfill.test.ts`:
- import `INCREMENTAL_TYPES` instead of `ALL_TYPES`;
- in `stubClient`, replace the `'contacts'` paging branch type with `'deals'`: ids `d1` (with `associations: { companies: … }`) on page 1 and `d2` on page 2;
- first test:
  - `expect(batches).toHaveLength(8)` (6 types, deals has 2 pages → 7 + 1 final live);
  - deals is now the first type, so `batches[0].items[0].record.id` is `'d1'`;
  - replace the `contactsPage1` lines with assertions on `batches[0]`: its cursor matches `{ v: 2, phase: 'backfill', step: 'deals', after: 'P2' }`, and its first item's `assoc` equals `{ companies: ['77'] }`;
  - loop `INCREMENTAL_TYPES` for watermarks;
- resume test: cursor `{ v: 2, phase: 'backfill', step: 'deals', after: 'P2', watermarks: { deals: '2026-01-01T00:00:00.000Z' }, … }`, and assert `wm.deals` preserved;
- emails-final test: add `v: 2`, loop `INCREMENTAL_TYPES`;
- every other literal backfill cursor in the file gets `v: 2`. Search the file for `phase: 'backfill'`.

Append to `backfill.test.ts`:
```ts
it('never lists pass-owned types and drops pass-owned emails', async () => {
  const { session } = mkSession();
  const paths: string[] = [];
  const client = {
    requestCount: 0,
    request: async <T>(_m: string, pathname: string): Promise<T> => {
      paths.push(pathname);
      const type = pathname.split('?')[0].split('/')[4];
      if (type === 'emails')
        return { results: [
          { id: 'out', properties: { hs_email_direction: 'EMAIL' } },
          { id: 'in', properties: { hs_email_direction: 'INCOMING_EMAIL' } },
        ] } as T;
      return { results: [] } as T;
    },
    download: async () => ({ bytes: new Uint8Array(), mime: 'x' }),
  };
  const batches = await drain(backfill(client as never, session, null, ctx));
  expect(paths.some((p) => /objects\/(contacts|companies|tasks)\b/.test(p))).toBe(false);
  const ids = batches.flatMap((b) => b.items.map((i) => (i as { record?: { id: string } }).record?.id));
  expect(ids).toContain('in');
  expect(ids).not.toContain('out');
  for (const b of batches) expect((b.cursor as { v: number }).v).toBe(2);
});
```

`src/__tests__/delta.test.ts`:
- `liveCursor` builds `{ v: 2, phase: 'live', watermarks: Object.fromEntries(INCREMENTAL_TYPES.map(...)) }`, typed with `IncrementalTypeKey`;
- first test: switch `contacts` → `deals`:
  - search path `/crm/v3/objects/deals/search`;
  - `propertyName: 'hs_lastmodifieddate'`;
  - record `{ id: 'd9', properties: { hs_lastmodifieddate: '2026-07-01T05:00:00.000Z' } }`;
  - association path `/crm/v4/associations/deals/companies/batch/read`;
  - assertions `item.kind === 'deals'`, `cur.watermarks.deals`;
- 'visits stalest type first': stale `notes` instead of `tasks`, expect `/crm/v3/objects/notes/search`;
- 'budget is unaffected…': `toHaveLength(INCREMENTAL_TYPES.length)`;
- 're-windows…': `contacts` → `deals`, `lastmodifieddate` → `hs_lastmodifieddate`.

Append to `delta.test.ts`:
```ts
it('drops pass-owned emails before reading associations but still advances the watermark', async () => {
  const client = stubClient((_m, pathname) => {
    if (pathname === '/crm/v3/objects/emails/search')
      return { results: [
        { id: 'out', properties: { hs_email_direction: 'EMAIL', hs_lastmodifieddate: '2026-07-02T00:00:00.000Z' } },
        { id: 'in', properties: { hs_email_direction: 'INCOMING_EMAIL', hs_lastmodifieddate: '2026-07-01T09:00:00.000Z' } },
      ] };
    if (pathname.endsWith('/search')) return emptySearch;
    return { results: [] };
  });
  const batches = await drain(delta(client as never, session, liveCursor(), ctx));
  const assocReads = client.calls.filter((c) => c.pathname.startsWith('/crm/v4/associations/emails/'));
  for (const c of assocReads) expect(c.body).toEqual({ inputs: [{ id: 'in' }] });
  const items = batches.flatMap((b) => b.items) as Array<{ record: { id: string } }>;
  expect(items.map((i) => i.record.id)).toEqual(['in']);
  const cur = batches.find((b) => b.items.length)!.cursor as LiveCursor;
  expect(cur.watermarks.emails).toBe('2026-07-02T00:00:00.000Z');
});

it('delta and sweep preserve dossier state on every cursor', async () => {
  const dossier = { lastCompletedAt: '2026-07-01T00:00:00.000Z', attemptedAt: null, scopes: { 'dom:x.co': 3 }, counts: { contacts: 5 } };
  const client = stubClient((_m, pathname) => {
    if (pathname === '/crm/v3/objects/notes/search')
      return { results: [{ id: 'n1', properties: { hs_lastmodifieddate: '2026-07-02T00:00:00.000Z' } }] };
    if (pathname.endsWith('/search')) return emptySearch;
    if (pathname.includes('archived=true') && pathname.includes('/objects/deals?'))
      return { results: [{ id: 'd1', properties: {} }] };
    return { results: [] };
  });
  const batches = await drain(delta(client as never, session, { ...liveCursor(), dossier }, ctx));
  expect(batches.length).toBeGreaterThan(1);
  for (const b of batches) {
    expect((b.cursor as LiveCursor).dossier).toEqual(dossier);
    expect((b.cursor as LiveCursor).v).toBe(2);
  }
});
```
(import `LiveCursor`, `INCREMENTAL_TYPES`, `IncrementalTypeKey` from `'../types'`.)

`src/__tests__/archived-sweep.test.ts`:
- `liveCursor` → `{ v: 2, phase: 'live', watermarks: …INCREMENTAL_TYPES…, archiveSweep }`, with `step: IncrementalTypeKey`;
- first test: replace the `contacts: { results: [{ id: 'c1' … }] }` entry with `deals: { results: [{ id: 'd1', properties: {} }] }`, and expect `{ externalId: 'd1', type: 'hubspot.deal' }`. Add:
  ```ts
  expect(client.calls.some((c) => /objects\/(contacts|companies|tasks)\?/.test(c))).toBe(false);
  ```
- 'resumes from a stored sweep position…': `tasks` → `notes` throughout (`/objects/notes?`, id `n1`, step `'notes'`, after `'T2'` unchanged);
- 'skips a type HubSpot cannot list archived…': the next type after meetings is now `emails`, the last incremental type:
  - remove the `tasks: { results: [{ id: 't1' … }] }` stub entry and every `t1`/`tasks` assertion;
  - expect `batches.map(sweepCursor)` to contain `{ step: 'emails', after: null }`;
- 'drops the pager when skipping mid-type…': look for `/objects/emails?` instead of `/objects/tasks?`;
- 'ends the pass when…': use `INCREMENTAL_TYPES[INCREMENTAL_TYPES.length - 1]`.

- [ ] **Step 2: Run to verify they fail**

Run: `npx jest src/__tests__/backfill.test.ts src/__tests__/delta.test.ts src/__tests__/archived-sweep.test.ts 2>&1 | tail -30`
Expected: FAIL — backfill lists `companies` first (length 11 ≠ 8), `v` undefined, `out` emitted, `dossier` missing from delta cursors.

- [ ] **Step 3: Implement**

`src/backfill.ts`:
- import `INCREMENTAL_TYPES`, `type IncrementalTypeKey` and `isPassOwnedEmail` (from `'./ownership'`); drop `ALL_TYPES`;
- `let stepIdx = Math.max(0, INCREMENTAL_TYPES.indexOf(cursor?.step ?? 'deals'));`; loop over `INCREMENTAL_TYPES`;
- inside the record loop, first line: `if (step === 'emails' && isPassOwnedEmail(record)) continue;`;
- every cursor literal gets `v: 2`; `next`'s live branch is `{ v: 2, phase: 'live', watermarks: { ...watermarks } as Record<IncrementalTypeKey, string> }`;
- final `full` is built from `INCREMENTAL_TYPES`;
- update the doc comment: "every incremental type in INCREMENTAL_TYPES order". Drop the "objects before engagements so parent refs resolve" rationale, since engagements are parentless now.

`src/delta.ts`:
- import `INCREMENTAL_TYPES`, `type IncrementalTypeKey`, `type LiveCursor`, `isPassOwnedEmail`; delete the local `LiveCursor` alias;
- `const order = [...INCREMENTAL_TYPES].sort((a, b) => (watermarks[a] < watermarks[b] ? -1 : 1));`;
- add near the top of `delta`:
  ```ts
  /** Spec §4 "Cursor preservation": every yielded cursor is the input cursor
   *  (so `dossier` and `v` survive) with only the changed fields replaced. */
  const live = (patch: Partial<LiveCursor>): HubSpotCursor =>
    structuredClone({ ...cursor, watermarks, ...patch });
  ```
- page loop: after `const records = page.results ?? []; if (records.length === 0) break;` add
  ```ts
  const kept = step === 'emails' ? records.filter((r) => !isPassOwnedEmail(r)) : records;
  const assocMap = await batchReadAssociations(client, step, kept.map((r) => r.id));
  ```
  Iterate `kept` for items, but compute `maxSeen` over **all** `records` (a separate loop before the item loop):
  ```ts
  let maxSeen = watermarks[step];
  for (const record of records) {
    const lm = record.properties[prop];
    if (lm && lm > maxSeen) maxSeen = lm;
  }
  ```
  and remove the `lm` lines from the item loop;
- yield `{ phase: 'live', items, cursor: live({ archiveSweep: cursor.archiveSweep }) }`;
- `archivedSweep` signature becomes `(client, session, sweep: LiveCursor['archiveSweep'], budgetLeft, live: (patch: Partial<LiveCursor>) => HubSpotCursor)`:
  - iterate `INCREMENTAL_TYPES`;
  - every cursor is `live({ archiveSweep: <value or undefined> })`, e.g. the budget-exhausted yield → `live({ archiveSweep: { step, after } })`; the unsupported skip → `live({ archiveSweep: next })`; the page yield → `live({ archiveSweep: nextSweep })`;
  - call site: `yield* archivedSweep(client, session, cursor.archiveSweep, budgetLeft, live);`;
  - `warnedUnsupported` / `isUnsupportedArchivedListing` become `IncrementalTypeKey`-typed;
- `batchReadAssociations(client, fromType: TypeKey, ids)` is unchanged.

Note: `structuredClone` keeps an `archiveSweep: undefined` key. The 'clears archiveSweep after a full pass' test uses `toBeUndefined()`, which passes.

- [ ] **Step 4: Run to verify they pass**

Run: `npx jest src/__tests__/backfill.test.ts src/__tests__/delta.test.ts src/__tests__/archived-sweep.test.ts src/__tests__/attachments.test.ts 2>&1 | tail -15`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/backfill.ts src/delta.ts src/__tests__/backfill.test.ts src/__tests__/delta.test.ts src/__tests__/archived-sweep.test.ts
git commit -m "feat(sync): narrow incremental path to standalone types, v2 cursors that keep dossier state"
```

---

### Task 4: Scope assignment

**Files:**
- Create: `src/dossier/scope.ts`
- Test: `src/__tests__/scope.test.ts`

**Interfaces:**
- Consumes: `normalizeDomain`, `emailDomain`, `isPublicDomain` (Task 1).
- Produces:
  ```ts
  export interface CompanyRow { id: string; domain: string | null; name: string; createdAt: string | null; block: string }
  export interface ContactRow { id: string; email: string | null; name: string; createdAt: string | null; companyIds: string[]; block: string }
  export interface ActivityRow { id: string; kind: 'emails' | 'tasks'; ts: string | null; contactIds: string[]; companyIds: string[]; block: string }
  export interface DossierIndex { companies: CompanyRow[]; contacts: ContactRow[]; activities: ActivityRow[] }
  export interface Section<R> { row: R; activities: ActivityRow[] }
  export interface Scope { key: string; domain: string | null; month: string | null; companies: Section<CompanyRow>[]; contacts: Section<ContactRow>[]; orphans: ActivityRow[] }
  export function cmpId(a: string, b: string): number
  export function monthOf(ts: string | null): string
  export function assignScopes(index: DossierIndex): Scope[] // sorted by key
  ```

- [ ] **Step 1: Write the failing test** — `src/__tests__/scope.test.ts`

```ts
import { assignScopes, cmpId, monthOf, type ActivityRow, type CompanyRow, type ContactRow } from '../dossier/scope';

const co = (id: string, domain: string | null): CompanyRow => ({ id, domain, name: `Co ${id}`, createdAt: '2025-01-01T00:00:00.000Z', block: `## Company ${id}` });
const ct = (id: string, email: string | null, companyIds: string[] = [], createdAt = '2026-07-03T00:00:00.000Z'): ContactRow => ({ id, email, name: `P ${id}`, createdAt, companyIds, block: `## P ${id}` });
const act = (id: string, contactIds: string[], companyIds: string[] = [], ts = '2026-08-01T00:00:00.000Z', kind: 'emails' | 'tasks' = 'emails'): ActivityRow => ({ id, kind, ts, contactIds, companyIds, block: `- ${id}` });

const byKey = (scopes: ReturnType<typeof assignScopes>) => Object.fromEntries(scopes.map((s) => [s.key, s]));

describe('cmpId / monthOf', () => {
  it('compares numeric ids numerically', () => {
    expect(cmpId('9', '10')).toBeLessThan(0);
    expect(cmpId('10', '10')).toBe(0);
  });
  it('buckets by UTC month, unknown when missing', () => {
    expect(monthOf('2026-07-03T10:00:00.000Z')).toBe('2026-07');
    expect(monthOf(null)).toBe('unknown');
    expect(monthOf('garbage')).toBe('unknown');
  });
});

describe('assignScopes', () => {
  it('joins companies and contacts on email domain', () => {
    const s = byKey(assignScopes({ companies: [co('1', 'www.Nike.com')], contacts: [ct('5', 'jane@nike.com')], activities: [] }));
    expect(Object.keys(s)).toEqual(['dom:nike.com']);
    expect(s['dom:nike.com'].domain).toBe('nike.com');
    expect(s['dom:nike.com'].companies.map((c) => c.row.id)).toEqual(['1']);
    expect(s['dom:nike.com'].contacts.map((c) => c.row.id)).toEqual(['5']);
  });

  it('public-domain contacts follow their smallest-id company scope, even a domainless one', () => {
    const s = byKey(assignScopes({
      companies: [co('20', 'acme.io'), co('3', null)],
      contacts: [ct('5', 'x@gmail.com', ['20', '3'])],
      activities: [],
    }));
    expect(s['co:3'].contacts.map((c) => c.row.id)).toEqual(['5']);
    expect(s['dom:acme.io'].contacts).toEqual([]);
  });

  it('unaffiliated public/no-email contacts go to ind:<createdate month>; unknown company ids are ignored', () => {
    const s = byKey(assignScopes({ companies: [], contacts: [ct('5', 'x@gmail.com', ['999']), ct('6', null, [], '2026-06-30T23:00:00.000Z')], activities: [] }));
    expect(s['ind:2026-07'].contacts.map((c) => c.row.id)).toEqual(['5']);
    expect(s['ind:2026-06'].contacts.map((c) => c.row.id)).toEqual(['6']);
  });

  it('activity owner = smallest-id contact in the index, else company, else orphan month', () => {
    const s = byKey(assignScopes({
      companies: [co('1', 'nike.com')],
      contacts: [ct('7', 'a@nike.com'), ct('30', 'b@other.com')],
      activities: [
        act('e1', ['30', '7']),
        act('e2', ['404'], ['1']),
        act('e3', ['404'], ['999'], '2025-02-10T00:00:00.000Z'),
      ],
    }));
    expect(s['dom:nike.com'].contacts.find((c) => c.row.id === '7')!.activities.map((a) => a.id)).toEqual(['e1']);
    expect(s['dom:nike.com'].companies[0].activities.map((a) => a.id)).toEqual(['e2']);
    expect(s['orphan:2025-02'].orphans.map((a) => a.id)).toEqual(['e3']);
    expect(s['dom:other.com'].contacts[0].activities).toEqual([]);
  });

  it('orders sections and activities deterministically and returns scopes sorted by key', () => {
    const scopes = assignScopes({
      companies: [co('10', 'b.com'), co('9', 'b.com')],
      contacts: [ct('2', 'y@b.com', [], '2026-02-01T00:00:00.000Z'), ct('1', 'x@b.com', [], '2026-03-01T00:00:00.000Z')],
      activities: [act('a2', ['2'], [], '2026-05-01T00:00:00.000Z'), act('a1', ['2'], [], '2026-04-01T00:00:00.000Z'), act('z', [], [], null)],
    });
    expect(scopes.map((s) => s.key)).toEqual(['dom:b.com', 'orphan:unknown']);
    const b = scopes[0];
    expect(b.companies.map((c) => c.row.id)).toEqual(['9', '10']);
    expect(b.contacts.map((c) => c.row.id)).toEqual(['2', '1']);
    expect(b.contacts[0].activities.map((a) => a.id)).toEqual(['a1', 'a2']);
    expect(scopes[1].month).toBe('unknown');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx jest src/__tests__/scope.test.ts 2>&1 | tail -15`
Expected: FAIL — `Cannot find module '../dossier/scope'`.

- [ ] **Step 3: Implement** — `src/dossier/scope.ts`

```ts
import { emailDomain, isPublicDomain, normalizeDomain } from './domains';

export interface CompanyRow { id: string; domain: string | null; name: string; createdAt: string | null; block: string }
export interface ContactRow { id: string; email: string | null; name: string; createdAt: string | null; companyIds: string[]; block: string }
export interface ActivityRow { id: string; kind: 'emails' | 'tasks'; ts: string | null; contactIds: string[]; companyIds: string[]; block: string }
export interface DossierIndex { companies: CompanyRow[]; contacts: ContactRow[]; activities: ActivityRow[] }
export interface Section<R> { row: R; activities: ActivityRow[] }
export interface Scope {
  key: string;
  domain: string | null;
  month: string | null;
  companies: Section<CompanyRow>[];
  contacts: Section<ContactRow>[];
  orphans: ActivityRow[];
}

/** HubSpot ids are decimal strings: shorter is smaller, then lexical. */
export function cmpId(a: string, b: string): number {
  return a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);
}

export function monthOf(ts: string | null): string {
  return ts && /^\d{4}-\d{2}/.test(ts) ? ts.slice(0, 7) : 'unknown';
}

const orgDomain = (d: string | null): string | null => (d && !isPublicDomain(d) ? d : null);

/** Spec §2. Pure: same index → same scopes, same order. */
export function assignScopes(index: DossierIndex): Scope[] {
  const scopes = new Map<string, Scope>();
  const scope = (key: string, domain: string | null, month: string | null): Scope => {
    let s = scopes.get(key);
    if (!s) scopes.set(key, (s = { key, domain, month, companies: [], contacts: [], orphans: [] }));
    return s;
  };

  const companyKey = new Map<string, string>();
  const companySection = new Map<string, Section<CompanyRow>>();
  for (const row of index.companies) {
    const d = orgDomain(normalizeDomain(row.domain));
    const key = d ? `dom:${d}` : `co:${row.id}`;
    companyKey.set(row.id, key);
    const sec = { row, activities: [] };
    companySection.set(row.id, sec);
    scope(key, d, null).companies.push(sec);
  }

  const contactSection = new Map<string, Section<ContactRow>>();
  for (const row of index.contacts) {
    const d = orgDomain(emailDomain(row.email));
    let key: string;
    let domain: string | null = d;
    let month: string | null = null;
    if (d) key = `dom:${d}`;
    else {
      const company = [...row.companyIds].sort(cmpId).find((id) => companyKey.has(id));
      if (company) {
        key = companyKey.get(company)!;
        domain = scopes.get(key)!.domain;
      } else {
        month = monthOf(row.createdAt);
        key = `ind:${month}`;
      }
    }
    const sec = { row, activities: [] };
    contactSection.set(row.id, sec);
    scope(key, domain, month).contacts.push(sec);
  }

  for (const a of index.activities) {
    const contact = [...a.contactIds].sort(cmpId).find((id) => contactSection.has(id));
    if (contact) { contactSection.get(contact)!.activities.push(a); continue; }
    const company = [...a.companyIds].sort(cmpId).find((id) => companySection.has(id));
    if (company) { companySection.get(company)!.activities.push(a); continue; }
    const month = monthOf(a.ts);
    scope(`orphan:${month}`, null, month).orphans.push(a);
  }

  const byTs = (x: ActivityRow, y: ActivityRow) => ((x.ts ?? '') < (y.ts ?? '') ? -1 : (x.ts ?? '') > (y.ts ?? '') ? 1 : cmpId(x.id, y.id));
  const out = [...scopes.values()].sort((x, y) => (x.key < y.key ? -1 : x.key > y.key ? 1 : 0));
  for (const s of out) {
    s.companies.sort((x, y) => cmpId(x.row.id, y.row.id));
    s.contacts.sort((x, y) => {
      const cx = x.row.createdAt ?? '';
      const cy = y.row.createdAt ?? '';
      return cx < cy ? -1 : cx > cy ? 1 : cmpId(x.row.id, y.row.id);
    });
    for (const sec of [...s.companies, ...s.contacts]) sec.activities.sort(byTs);
    s.orphans.sort(byTs);
  }
  return out;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx jest src/__tests__/scope.test.ts 2>&1 | tail -15`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/dossier/scope.ts src/__tests__/scope.test.ts
git commit -m "feat(dossier): scope assignment by domain, company and month"
```

---

### Task 5: Blocks and part layout

**Files:**
- Create: `src/dossier/blocks.ts`, `src/dossier/layout.ts`
- Test: `src/__tests__/dossier-layout.test.ts`

**Interfaces:**
- Consumes:
  - `renderItem`, `recordUrl`, `parseEmailHeaders` (`src/docs.ts`, Task 2);
  - `htmlToText`, `truncate` (`src/render.ts`);
  - `assocFromRecord` (`src/backfill.ts`);
  - `Scope` and the row types (Task 4).
- Produces:
  ```ts
  // blocks.ts
  export const BLOCK_MAX = 6000; export const FOLD_BODY_MAX = 4000; export const TRUNC_MARK = '… [truncated — open in HubSpot]';
  export function capText(text: string, max: number): string
  export function companyRow(record: HubSpotRecord, ctx: RenderContext): CompanyRow
  export function contactRow(record: HubSpotRecord, ctx: RenderContext): ContactRow
  export function activityRow(kind: 'emails' | 'tasks', record: HubSpotRecord, ctx: RenderContext): ActivityRow
  // layout.ts
  export const PART_MAX_CHARS = 8000; export const DOSSIER_DOC_TYPE = 'hubspot.dossier';
  export function partId(key: string, i: number): string
  export function layoutScope(scope: Scope, portalId: string): DocumentInput[]
  ```

- [ ] **Step 1: Write the failing test** — `src/__tests__/dossier-layout.test.ts`

```ts
import { activityRow, BLOCK_MAX, capText, companyRow, contactRow, FOLD_BODY_MAX, TRUNC_MARK } from '../dossier/blocks';
import { layoutScope, PART_MAX_CHARS, partId } from '../dossier/layout';
import { assignScopes } from '../dossier/scope';
import { ctx } from '../testing/fixtures';

const rec = (id: string, properties: Record<string, string | null>, associations?: Record<string, { results: Array<{ id: string; type: string }> }>) =>
  ({ id, properties, associations });

describe('blocks', () => {
  it('capText keeps short text and cuts long text with the marker', () => {
    expect(capText('abc', 10)).toBe('abc');
    const out = capText('x'.repeat(100), 50);
    expect(out.length).toBeLessThanOrEqual(50);
    expect(out.endsWith(TRUNC_MARK)).toBe(true);
  });

  it('renders a contact section with a linked heading and its company associations', () => {
    const row = contactRow(rec('5', { firstname: 'Jane', lastname: 'Doe', email: 'jane@nike.com', createdate: '2026-07-03T00:00:00.000Z' }, { companies: { results: [{ id: '1', type: 'x' }] } }), ctx);
    expect(row).toMatchObject({ id: '5', email: 'jane@nike.com', name: 'Jane Doe', companyIds: ['1'], createdAt: '2026-07-03T00:00:00.000Z' });
    expect(row.block.split('\n')[0]).toBe('## Jane Doe · [open](https://app.hubspot.com/contacts/123/record/0-1/5)');
    expect(row.block).toContain('**Email:** jane@nike.com');
  });

  it('renders a company section, capping a huge description', () => {
    const row = companyRow(rec('1', { name: 'Nike', domain: 'nike.com', description: 'd'.repeat(20_000) }), ctx);
    expect(row).toMatchObject({ id: '1', domain: 'nike.com', name: 'Nike' });
    expect(row.block.startsWith('## Company: Nike · [open](https://app.hubspot.com/contacts/123/record/0-2/1)')).toBe(true);
    expect(row.block.length).toBeLessThanOrEqual(BLOCK_MAX);
  });

  it('renders a folded email entry with sender, subject and a body capped at FOLD_BODY_MAX', () => {
    const row = activityRow('emails', rec('e1', {
      hs_timestamp: '2025-07-09T10:00:00.000Z', hs_email_subject: 'Re: hello',
      hs_email_headers: JSON.stringify({ from: { email: 'daniel@grips.co' }, to: [{ email: 'jane@nike.com' }] }),
      hs_email_text: 'b'.repeat(10_000),
    }, { contacts: { results: [{ id: '5', type: 'x' }] } }), ctx);
    expect(row).toMatchObject({ id: 'e1', kind: 'emails', ts: '2025-07-09T10:00:00.000Z', contactIds: ['5'], companyIds: [] });
    expect(row.block.split('\n')[0]).toBe('- 2025-07-09 · Email sent (daniel@grips.co) · "Re: hello"');
    expect(row.block).toContain(TRUNC_MARK);
    expect(row.block.length).toBeLessThan(FOLD_BODY_MAX + 300);
  });

  it('renders a task entry', () => {
    const row = activityRow('tasks', rec('t1', { hs_timestamp: '2025-07-12T00:00:00.000Z', hs_task_subject: 'LinkedIn: Visit Profile', hs_task_status: 'COMPLETED' }), ctx);
    expect(row.block).toBe('- 2025-07-12 · Task · LinkedIn: Visit Profile · COMPLETED');
  });
});

describe('layoutScope', () => {
  const index = (contacts: number, bodyChars: number) => ({
    companies: [companyRow(rec('1', { name: 'Nike', domain: 'nike.com', createdate: '2020-01-01T00:00:00.000Z' }), ctx)],
    contacts: Array.from({ length: contacts }, (_, i) =>
      contactRow(rec(String(100 + i), { firstname: `P${i}`, email: `p${i}@nike.com`, createdate: `2026-07-0${1 + (i % 9)}T00:00:00.000Z` }), ctx)),
    // two sends per contact, so a contact's activity can spill into the next part
    activities: Array.from({ length: contacts * 2 }, (_, i) =>
      activityRow('emails', rec(`e${i}`, { hs_timestamp: '2026-08-01T00:00:00.000Z', hs_email_subject: 's', hs_email_text: 'w'.repeat(bodyChars) },
        { contacts: { results: [{ id: String(100 + (i % contacts)), type: 'x' }] } }), ctx)),
  });

  it('one small scope → one part titled "<company> (<domain>)" with a stable id and no counts', () => {
    const [scope] = assignScopes(index(2, 10));
    const parts = layoutScope(scope, ctx.portalId);
    expect(parts).toHaveLength(1);
    expect(parts[0].externalId).toBe(partId('dom:nike.com', 0));
    expect(parts[0].externalId).toBe('hubspot-dossier:dom:nike.com:0');
    expect(parts[0].type).toBe('hubspot.dossier');
    expect(parts[0].title).toBe('Nike (nike.com)');
    expect(parts[0].url).toBe('https://app.hubspot.com/contacts/123/record/0-2/1');
    expect(parts[0].parent).toBeUndefined();
    expect(parts[0].metadata).toMatchObject({ scope: 'dom:nike.com', domain: 'nike.com', part: 0, companyIds: ['1'] });
    expect(parts[0].metadata.participants).toEqual(expect.arrayContaining(['p0@nike.com', 'p1@nike.com']));
    expect(parts[0].metadata.engagementIds).toEqual(expect.arrayContaining(['e0', 'e1']));
    expect(parts[0].createdAt).toBe('2026-08-01T00:00:00.000Z');
    expect(JSON.stringify(parts[0])).not.toMatch(/part \d+\/\d+|"parts"/);
  });

  it('no part exceeds PART_MAX_CHARS even with oversized blocks; continuation headers repeat', () => {
    const [scope] = assignScopes(index(30, 9_000));
    const parts = layoutScope(scope, ctx.portalId);
    expect(parts.length).toBeGreaterThan(5);
    for (const p of parts) expect(p.markdown!.length).toBeLessThanOrEqual(PART_MAX_CHARS);
    expect(parts[1].title).toBe('Nike (nike.com) — part 2');
    expect(parts.some((p) => /\(cont\.\)/.test(p.markdown!))).toBe(true);
    expect(parts.map((p) => p.externalId)).toEqual(parts.map((_, i) => partId('dom:nike.com', i)));
  });

  it('adding a contact at the end leaves earlier parts byte-identical', () => {
    const a = layoutScope(assignScopes(index(30, 3_000))[0], ctx.portalId);
    const bigger = index(30, 3_000);
    bigger.contacts.push(contactRow(rec('999', { firstname: 'Late', email: 'late@nike.com', createdate: '2026-09-30T00:00:00.000Z' }), ctx));
    const b = layoutScope(assignScopes(bigger)[0], ctx.portalId);
    expect(b.slice(0, a.length - 1)).toEqual(a.slice(0, a.length - 1));
  });

  it('titles individuals and orphan buckets', () => {
    const scopes = assignScopes({
      companies: [],
      contacts: [contactRow(rec('5', { firstname: 'X', email: 'x@gmail.com', createdate: '2026-07-03T00:00:00.000Z' }), ctx)],
      activities: [activityRow('tasks', rec('t1', { hs_timestamp: '2025-02-01T00:00:00.000Z', hs_task_subject: 'Call' }), ctx)],
    });
    const titles = scopes.map((s) => layoutScope(s, ctx.portalId)[0].title);
    expect(titles).toEqual(['Individuals — 2026-07', 'Unassigned activity — 2025-02']);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx jest src/__tests__/dossier-layout.test.ts 2>&1 | tail -15`
Expected: FAIL — `Cannot find module '../dossier/blocks'`.

- [ ] **Step 3: Implement**

`src/dossier/blocks.ts`:
```ts
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
```

`src/dossier/layout.ts`:
```ts
import type { DocumentInput } from '@kiagent/connector-sdk';
import { recordUrl } from '../docs';
import { truncate } from '../render';
import type { RenderContext } from '../types';
import type { Scope } from './scope';

export const PART_MAX_CHARS = 8000;
export const DOSSIER_DOC_TYPE = 'hubspot.dossier';
/** Part header + one continuation heading always fit beside a BLOCK_MAX block. */
const HEADER_RESERVE = 1_000;
const BODY_MAX = PART_MAX_CHARS - HEADER_RESERVE;
const TITLE_MAX = 200;

export const partId = (key: string, i: number): string => `hubspot-dossier:${key}:${i}`;

interface Unit {
  text: string;
  /** Heading repeated when this unit opens a part mid-section; null for a section's own heading. */
  cont: string | null;
  contactId?: string;
  companyId?: string;
  engagementId?: string;
  email?: string | null;
  ts: string | null;
}

function units(scope: Scope): Unit[] {
  const out: Unit[] = [];
  for (const { row, activities } of scope.companies) {
    out.push({ text: row.block, cont: null, companyId: row.id, ts: row.createdAt });
    const cont = `## Company: ${truncate(row.name, TITLE_MAX)} (cont.)`;
    for (const a of activities) out.push({ text: a.block, cont, companyId: row.id, engagementId: a.id, ts: a.ts });
  }
  for (const { row, activities } of scope.contacts) {
    out.push({ text: row.block, cont: null, contactId: row.id, email: row.email, ts: row.createdAt });
    const cont = `## ${truncate(row.name, TITLE_MAX)} (cont.)`;
    for (const a of activities) out.push({ text: a.block, cont, contactId: row.id, email: row.email, engagementId: a.id, ts: a.ts });
  }
  for (const a of scope.orphans) out.push({ text: a.block, cont: null, engagementId: a.id, ts: a.ts });
  return out;
}

function baseTitle(scope: Scope): string {
  const kind = scope.key.slice(0, scope.key.indexOf(':'));
  if (kind === 'ind') return `Individuals — ${scope.month}`;
  if (kind === 'orphan') return `Unassigned activity — ${scope.month}`;
  if (scope.companies.length === 1) {
    const name = truncate(scope.companies[0].row.name, TITLE_MAX);
    return scope.domain ? `${name} (${scope.domain})` : name;
  }
  return scope.domain ?? scope.key;
}

function subline(scope: Scope): string {
  const kind = scope.key.slice(0, scope.key.indexOf(':'));
  if (kind === 'dom') return `Organisation: ${scope.domain}`;
  if (kind === 'co') return `Company record ${scope.key.slice(3)}`;
  if (kind === 'ind') return `Contacts without a company domain, created ${scope.month}`;
  return `Sequence emails and tasks with no contact or company, ${scope.month}`;
}

/** Spec §3: greedy packing into ≤ PART_MAX_CHARS parts, no totals anywhere. */
export function layoutScope(scope: Scope, portalId: string): DocumentInput[] {
  const all = units(scope);
  const groups: Unit[][] = [];
  let cur: Unit[] = [];
  let len = 0;
  const cost = (u: Unit, first: boolean) => (first ? (u.cont ? u.cont.length + 2 : 0) : 2) + u.text.length;
  for (const u of all) {
    if (cur.length && len + cost(u, false) > BODY_MAX) {
      groups.push(cur);
      cur = [];
      len = 0;
    }
    len += cost(u, cur.length === 0);
    cur.push(u);
  }
  if (cur.length) groups.push(cur);

  const title = baseTitle(scope);
  const ctx = { portalId } as RenderContext;
  const soleCompany = scope.companies.length === 1 ? scope.companies[0].row.id : null;
  return groups.map((g, i) => {
    const suffix = i > 0 ? ` — part ${i + 1}` : '';
    const header = `# ${title}${suffix}\n${subline(scope)}${i > 0 ? ` · part ${i + 1}` : ''}`;
    const markdown = [header, ...(g[0].cont ? [g[0].cont] : []), ...g.map((u) => u.text)].join('\n\n');
    const uniq = (xs: Array<string | null | undefined>) => [...new Set(xs.filter((x): x is string => Boolean(x)))];
    const contactIds = uniq(g.map((u) => u.contactId));
    const createdAt = g.reduce<string | null>((m, u) => (u.ts && (!m || u.ts > m) ? u.ts : m), null);
    const url = soleCompany
      ? recordUrl(ctx, 'companies', soleCompany)
      : contactIds[0]
        ? recordUrl(ctx, 'contacts', contactIds[0])
        : uniq(g.map((u) => u.companyId))[0]
          ? recordUrl(ctx, 'companies', uniq(g.map((u) => u.companyId))[0])
          : undefined;
    return {
      externalId: partId(scope.key, i),
      type: DOSSIER_DOC_TYPE,
      title: `${title}${suffix}`,
      markdown,
      ...(url ? { url } : {}),
      metadata: {
        scope: scope.key,
        ...(scope.domain ? { domain: scope.domain } : {}),
        part: i,
        contactIds,
        companyIds: uniq(g.map((u) => u.companyId)),
        engagementIds: uniq(g.map((u) => u.engagementId)),
        participants: uniq(g.map((u) => u.email?.toLowerCase())),
      },
      createdAt,
    };
  });
}
```
`recordUrl` reads only `ctx.portalId`, so the `{ portalId } as RenderContext` cast is safe.

- [ ] **Step 4: Run to verify it passes**

Run: `npx jest src/__tests__/dossier-layout.test.ts src/__tests__/scope.test.ts 2>&1 | tail -15`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/dossier/blocks.ts src/dossier/layout.ts src/__tests__/dossier-layout.test.ts
git commit -m "feat(dossier): bounded section blocks and part layout"
```

---

### Task 6: The dossier pass

**Files:**
- Create: `src/dossier/pass.ts`
- Test: `src/__tests__/dossier-pass.test.ts`

**Interfaces:**
- Consumes:
  - Tasks 1, 4 and 5;
  - `propsFor` (`src/properties.ts`);
  - `isPassOwnedEmail`;
  - `HubSpotClient.request`.
- Produces:
  ```ts
  export const DOSSIER_EVERY_MS = 6 * 3_600_000; export const DOSSIER_RETRY_MS = 3_600_000;
  export const CHUNK_MAX_CHARS = 2_000_000; export const SHRINK_RATIO = 0.5;
  export function emptyDossier(): DossierState
  export function isPassDue(d: DossierState | undefined, nowMs: number): boolean
  export function dossierPass(client: Pick<HubSpotClient, 'request'>, session: Session, cursor: LiveCursor, ctx: RenderContext, nowMs: number, chunkMaxChars?: number): AsyncGenerator<Batch<HubSpotCursor, HubSpotItem>>
  ```

- [ ] **Step 1: Write the failing test** — `src/__tests__/dossier-pass.test.ts`

```ts
import type { Batch, Session } from '@kiagent/connector-sdk';
import { dossierPass, DOSSIER_EVERY_MS, DOSSIER_RETRY_MS, emptyDossier, isPassDue } from '../dossier/pass';
import { partId } from '../dossier/layout';
import { ctx } from '../testing/fixtures';
import { INCREMENTAL_TYPES, type HubSpotCursor, type HubSpotItem, type LiveCursor } from '../types';

const NOW = Date.parse('2026-10-13T12:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();
const mkSession = () => {
  const ac = new AbortController();
  return { ac, session: { signal: ac.signal, log: jest.fn() } as unknown as Session };
};
const live = (dossier?: LiveCursor['dossier']): LiveCursor => ({
  v: 2,
  phase: 'live',
  watermarks: Object.fromEntries(INCREMENTAL_TYPES.map((t) => [t, '2026-10-01T00:00:00.000Z'])) as LiveCursor['watermarks'],
  ...(dossier ? { dossier } : {}),
});

type Rec = { id: string; properties: Record<string, string | null>; associations?: Record<string, { results: Array<{ id: string; type: string }> }> };
/** One page per type; `onList` sees every list path. */
function client(data: Partial<Record<'contacts' | 'companies' | 'tasks' | 'emails', Rec[]>>, onList?: (path: string) => void) {
  return {
    request: async <T>(_m: string, path: string): Promise<T> => {
      onList?.(path);
      const type = path.split('?')[0].split('/')[4] as keyof typeof data;
      return { results: data[type] ?? [] } as T;
    },
  };
}
const contact = (id: string, email: string): Rec => ({ id, properties: { email, firstname: `P${id}`, createdate: '2026-07-01T00:00:00.000Z' } });
const outbound = (id: string, contactId: string, attach = ''): Rec => ({
  id, properties: { hs_email_direction: 'EMAIL', hs_attachment_ids: attach, hs_timestamp: '2026-08-01T00:00:00.000Z', hs_email_text: 'x'.repeat(3000) },
  associations: { contacts: { results: [{ id: contactId, type: 'x' }] } },
});

async function drain(gen: AsyncIterable<Batch<HubSpotCursor, HubSpotItem>>) {
  const out: Batch<HubSpotCursor, HubSpotItem>[] = [];
  for await (const b of gen) out.push(b);
  return out;
}
const docsOf = (bs: Batch<HubSpotCursor, HubSpotItem>[]) =>
  bs.flatMap((b) => b.items.flatMap((i) => (i.kind === 'dossier' ? i.docs : [])));
const lastDossier = (bs: Batch<HubSpotCursor, HubSpotItem>[]) => (bs[bs.length - 1].cursor as LiveCursor).dossier!;

describe('isPassDue', () => {
  it('runs when never run, waits DOSSIER_EVERY after success and DOSSIER_RETRY after an attempt', () => {
    expect(isPassDue(undefined, NOW)).toBe(true);
    expect(isPassDue({ ...emptyDossier(), lastCompletedAt: iso(NOW - DOSSIER_EVERY_MS + 1), attemptedAt: iso(NOW - DOSSIER_EVERY_MS + 1) }, NOW)).toBe(false);
    expect(isPassDue({ ...emptyDossier(), lastCompletedAt: iso(NOW - DOSSIER_EVERY_MS), attemptedAt: iso(NOW - DOSSIER_EVERY_MS) }, NOW)).toBe(true);
    expect(isPassDue({ ...emptyDossier(), lastCompletedAt: null, attemptedAt: iso(NOW - DOSSIER_RETRY_MS + 1) }, NOW)).toBe(false);
  });
});

describe('dossierPass', () => {
  it('commits attemptedAt first, then dossier chunks, then a final batch completing the pass', async () => {
    const { session } = mkSession();
    const listed: string[] = [];
    const bs = await drain(dossierPass(client({ contacts: [contact('5', 'a@nike.com')], emails: [outbound('e1', '5')] }, (p) => listed.push(p)), session, live(), ctx, NOW));
    expect(bs[0].items).toEqual([]);
    expect((bs[0].cursor as LiveCursor).dossier!.attemptedAt).toBe(iso(NOW));
    expect((bs[0].cursor as LiveCursor).dossier!.lastCompletedAt).toBeNull();
    expect(listed.some((p) => p.startsWith('/crm/v3/objects/contacts?') && p.includes('associations=companies'))).toBe(true);
    expect(listed.some((p) => p.startsWith('/crm/v3/objects/emails?') && p.includes('associations=contacts%2Ccompanies'))).toBe(true);
    const docs = docsOf(bs);
    expect(docs.map((d) => d.externalId)).toEqual([partId('dom:nike.com', 0)]);
    expect(docs[0].markdown).toContain('Email sent');
    const d = lastDossier(bs);
    expect(d).toMatchObject({ lastCompletedAt: iso(NOW), attemptedAt: iso(NOW), scopes: { 'dom:nike.com': 1 }, counts: { contacts: 1, companies: 0, tasks: 0, emails: 1 } });
    for (const b of bs) expect((b.cursor as LiveCursor).watermarks).toEqual(live().watermarks);
  });

  it('skips incoming and attached emails, and deletes the standalone ref of every folded email', async () => {
    const { session } = mkSession();
    const incoming: Rec = { id: 'in', properties: { hs_email_direction: 'INCOMING_EMAIL' }, associations: { contacts: { results: [{ id: '5', type: 'x' }] } } };
    const bs = await drain(dossierPass(client({ contacts: [contact('5', 'a@nike.com')], emails: [outbound('e1', '5'), outbound('e2', '5', '77'), incoming] }), session, live(), ctx, NOW));
    const md = docsOf(bs)[0].markdown!;
    expect(docsOf(bs)[0].metadata.engagementIds).toEqual(['e1']);
    expect(md).not.toContain('e2');
    const dels = bs.flatMap((b) => b.deletions ?? []);
    expect(dels).toContainEqual({ externalId: 'e1', type: 'hubspot.email' });
    expect(dels).not.toContainEqual({ externalId: 'e2', type: 'hubspot.email' });
    expect(dels).not.toContainEqual({ externalId: 'in', type: 'hubspot.email' });
  });

  it('final batch deletes trailing parts of shrunk scopes and every part of vanished scopes', async () => {
    const { session } = mkSession();
    const prev = { ...emptyDossier(), lastCompletedAt: iso(NOW - DOSSIER_EVERY_MS), attemptedAt: iso(NOW - DOSSIER_EVERY_MS), scopes: { 'dom:nike.com': 3, 'dom:gone.com': 2 }, counts: { contacts: 1, emails: 1 } };
    const bs = await drain(dossierPass(client({ contacts: [contact('5', 'a@nike.com')], emails: [outbound('e1', '5')] }), session, live(prev), ctx, NOW));
    const final = bs[bs.length - 1];
    expect(final.items).toEqual([]);
    expect(final.deletions).toEqual(expect.arrayContaining([
      { externalId: partId('dom:nike.com', 1), type: 'hubspot.dossier' },
      { externalId: partId('dom:nike.com', 2), type: 'hubspot.dossier' },
      { externalId: partId('dom:gone.com', 0), type: 'hubspot.dossier' },
      { externalId: partId('dom:gone.com', 1), type: 'hubspot.dossier' },
    ]));
    expect(final.deletions).not.toContainEqual({ externalId: partId('dom:nike.com', 0), type: 'hubspot.dossier' });
    expect(lastDossier(bs).scopes).toEqual({ 'dom:nike.com': 1 });
  });

  it('high-water map covers parts of an interrupted multi-chunk scope', async () => {
    const { session, ac } = mkSession();
    const contacts = Array.from({ length: 40 }, (_, i) => contact(String(100 + i), `p${i}@nike.com`));
    const emails = contacts.map((c, i) => outbound(`e${i}`, c.id));
    const gen = dossierPass(client({ contacts, emails }), session, live(), ctx, NOW, 20_000);
    const seen: Batch<HubSpotCursor, HubSpotItem>[] = [];
    for await (const b of gen) {
      seen.push(b);
      if (seen.length === 3) ac.abort(); // attemptedAt + two chunks committed, then "sleep"
    }
    const committedParts = docsOf(seen).filter((d) => d.externalId.startsWith('hubspot-dossier:dom:nike.com:')).length;
    expect(committedParts).toBeGreaterThan(1);
    const d = (seen[seen.length - 1].cursor as LiveCursor).dossier!;
    expect(d.scopes['dom:nike.com']).toBeGreaterThanOrEqual(committedParts);
    expect(d.lastCompletedAt).toBeNull();
    for (const b of seen) for (const i of b.items) if (i.kind === 'dossier') expect(i.docs.reduce((n, x) => n + x.markdown!.length, 0)).toBeLessThanOrEqual(20_000 + 8_000);
  });

  it('shrink guard skips deletions and lastCompletedAt when a listing collapses', async () => {
    const { session } = mkSession();
    const prev = { ...emptyDossier(), lastCompletedAt: iso(NOW - DOSSIER_EVERY_MS), attemptedAt: iso(NOW - DOSSIER_EVERY_MS), scopes: { 'dom:gone.com': 2 }, counts: { contacts: 100 } };
    const bs = await drain(dossierPass(client({ contacts: [contact('5', 'a@nike.com')] }), session, live(prev), ctx, NOW));
    expect(bs.flatMap((b) => b.deletions ?? []).filter((r) => r.type === 'hubspot.dossier')).toEqual([]);
    const d = lastDossier(bs);
    expect(d.lastCompletedAt).toBe(prev.lastCompletedAt);
    expect(d.counts).toEqual(prev.counts);
    expect(d.scopes['dom:gone.com']).toBe(2);
    expect((session.log as jest.Mock).mock.calls.some(([lvl]) => lvl === 'warn')).toBe(true);
  });

  it('pages each listing with `after` until paging.next is absent', async () => {
    const { session } = mkSession();
    const paths: string[] = [];
    const c = {
      request: async <T>(_m: string, path: string): Promise<T> => {
        paths.push(path);
        if (path.startsWith('/crm/v3/objects/contacts?') && !path.includes('after='))
          return { results: [contact('1', 'a@x.com')], paging: { next: { after: 'C2' } } } as T;
        if (path.startsWith('/crm/v3/objects/contacts?')) return { results: [contact('2', 'b@x.com')] } as T;
        return { results: [] } as T;
      },
    };
    const bs = await drain(dossierPass(c, session, live(), ctx, NOW));
    expect(paths.filter((p) => p.startsWith('/crm/v3/objects/contacts?'))).toHaveLength(2);
    expect(lastDossier(bs).counts.contacts).toBe(2);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx jest src/__tests__/dossier-pass.test.ts 2>&1 | tail -15`
Expected: FAIL — `Cannot find module '../dossier/pass'`.

- [ ] **Step 3: Implement** — `src/dossier/pass.ts`

```ts
import type { Batch, DocumentInput, ExternalRef, Session } from '@kiagent/connector-sdk';
import type { HubSpotClient } from '../client';
import { isPassOwnedEmail } from '../ownership';
import { propsFor } from '../properties';
import {
  DOC_TYPE,
  PASS_TYPES,
  type DossierState,
  type HubSpotCursor,
  type HubSpotItem,
  type HubSpotRecord,
  type ListEnvelope,
  type LiveCursor,
  type PassTypeKey,
  type RenderContext,
} from '../types';
import { activityRow, companyRow, contactRow } from './blocks';
import { DOSSIER_DOC_TYPE, layoutScope, partId } from './layout';
import { assignScopes, type DossierIndex, type Scope } from './scope';

export const DOSSIER_EVERY_MS = 6 * 3_600_000;
export const DOSSIER_RETRY_MS = 3_600_000;
export const CHUNK_MAX_CHARS = 2_000_000;
export const SHRINK_RATIO = 0.5;
const PAGE_LIMIT = 100;

/** Associations each listing carries inline (spec §4 step 1). */
const LIST_ASSOC: Record<PassTypeKey, string[]> = {
  companies: [],
  contacts: ['companies'],
  tasks: ['contacts', 'companies'],
  emails: ['contacts', 'companies'],
};

export function emptyDossier(): DossierState {
  return { lastCompletedAt: null, attemptedAt: null, scopes: {}, counts: {} };
}

export function isPassDue(d: DossierState | undefined, nowMs: number): boolean {
  const s = d ?? emptyDossier();
  const since = (t: string | null) => (t ? nowMs - Date.parse(t) : Infinity);
  return since(s.lastCompletedAt) >= DOSSIER_EVERY_MS && since(s.attemptedAt) >= DOSSIER_RETRY_MS;
}

function listPath(type: PassTypeKey, after: string | null, ctx: RenderContext): string {
  const params = new URLSearchParams({ limit: String(PAGE_LIMIT), archived: 'false', properties: propsFor(type, ctx).join(',') });
  if (LIST_ASSOC[type].length) params.set('associations', LIST_ASSOC[type].join(','));
  if (after) params.set('after', after);
  return `/crm/v3/objects/${type}?${params.toString()}`;
}

/** Pages one type to the end. Returns the number of records seen, or null on abort. */
async function listAll(
  client: Pick<HubSpotClient, 'request'>,
  session: Session,
  type: PassTypeKey,
  ctx: RenderContext,
  onRecord: (r: HubSpotRecord) => void,
): Promise<number | null> {
  let after: string | null = null;
  let n = 0;
  do {
    if (session.signal.aborted) return null;
    const page: ListEnvelope = await client.request<ListEnvelope>('GET', listPath(type, after, ctx));
    for (const r of page.results ?? []) {
      n += 1;
      onRecord(r);
    }
    after = page.paging?.next?.after ?? null;
  } while (after);
  return n;
}

function foldedEmailRefs(scope: Scope): ExternalRef[] {
  const acts = [...scope.companies, ...scope.contacts].flatMap((s) => s.activities).concat(scope.orphans);
  return acts.filter((a) => a.kind === 'emails').map((a) => ({ externalId: a.id, type: DOC_TYPE.emails }));
}

/**
 * Spec §4. Full rebuild of every pass-owned record into dossier parts:
 * attemptedAt → list (render while listing) → chunks of ≤ chunkMaxChars,
 * one item per batch (atomic) → final batch with stale-part deletions.
 * Not resumable: an abort simply stops; the next attempt starts over.
 */
export async function* dossierPass(
  client: Pick<HubSpotClient, 'request'>,
  session: Session,
  cursor: LiveCursor,
  ctx: RenderContext,
  nowMs: number,
  chunkMaxChars: number = CHUNK_MAX_CHARS,
): AsyncGenerator<Batch<HubSpotCursor, HubSpotItem>> {
  const prev = cursor.dossier ?? emptyDossier();
  const startedAt = new Date(nowMs).toISOString();
  let state: DossierState = { ...prev, attemptedAt: startedAt };
  const snap = (): HubSpotCursor => structuredClone({ ...cursor, dossier: state });
  yield { phase: 'live', items: [], cursor: snap() };

  const index: DossierIndex = { companies: [], contacts: [], activities: [] };
  const counts: Partial<Record<PassTypeKey, number>> = {};
  for (const type of PASS_TYPES) {
    const n = await listAll(client, session, type, ctx, (r) => {
      if (type === 'companies') index.companies.push(companyRow(r, ctx));
      else if (type === 'contacts') index.contacts.push(contactRow(r, ctx));
      else if (type === 'tasks') index.activities.push(activityRow('tasks', r, ctx));
      else if (isPassOwnedEmail(r)) index.activities.push(activityRow('emails', r, ctx));
    });
    if (n === null) return;
    counts[type] = n;
  }

  const hi: Record<string, number> = { ...prev.scopes };
  const newP: Record<string, number> = {};
  let docs: DocumentInput[] = [];
  let chars = 0;
  let deletions: ExternalRef[] = [];
  const flush = (): Batch<HubSpotCursor, HubSpotItem> => {
    state = { ...state, scopes: { ...hi } };
    const b: Batch<HubSpotCursor, HubSpotItem> = {
      phase: 'live',
      items: docs.length ? [{ kind: 'dossier', docs }] : [],
      deletions,
      cursor: snap(),
    };
    docs = [];
    chars = 0;
    deletions = [];
    return b;
  };

  for (const scope of assignScopes(index)) {
    if (session.signal.aborted) return;
    const parts = layoutScope(scope, ctx.portalId);
    newP[scope.key] = parts.length;
    // Chunk by PARTS (spec §4): a giant scope spans several chunks; the
    // high-water mark rides each chunk's cursor so no committed part is lost.
    for (let i = 0; i < parts.length; i++) {
      if (session.signal.aborted) return;
      docs.push(parts[i]);
      chars += parts[i].markdown?.length ?? 0;
      hi[scope.key] = Math.max(hi[scope.key] ?? 0, i + 1);
      if (chars >= chunkMaxChars) yield flush();
    }
    deletions.push(...foldedEmailRefs(scope));
  }
  if (session.signal.aborted) return;
  if (docs.length || deletions.length) yield flush();

  const shrunk = PASS_TYPES.filter((t) => (prev.counts[t] ?? 0) > 0 && (counts[t] ?? 0) < (prev.counts[t] ?? 0) * SHRINK_RATIO);
  if (shrunk.length) {
    session.log('warn', `hubspot dossier pass: ${shrunk.join(', ')} listing shrank below ${SHRINK_RATIO * 100}% of the last pass — skipping deletions`);
    yield { phase: 'live', items: [], cursor: snap() };
    return;
  }

  const stale: ExternalRef[] = [];
  for (const [key, high] of Object.entries(hi)) {
    for (let i = newP[key] ?? 0; i < high; i++) stale.push({ externalId: partId(key, i), type: DOSSIER_DOC_TYPE });
  }
  state = { lastCompletedAt: startedAt, attemptedAt: startedAt, scopes: newP, counts };
  yield { phase: 'live', items: [], deletions: stale, cursor: snap() };
}
```
A chunk is at most `chunkMaxChars` + one part. The test's bound `≤ 20_000 + 8_000` pins this.

- [ ] **Step 4: Run to verify it passes**

Run: `npx jest src/__tests__/dossier-pass.test.ts 2>&1 | tail -20`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/dossier/pass.ts src/__tests__/dossier-pass.test.ts
git commit -m "feat(dossier): six-hourly dossier pass with atomic chunks and shrink guard"
```

---

### Task 7: Wire into the source, version gate, docs and 0.2.0

**Files:**
- Modify: `src/source.ts`, `src/__tests__/source.test.ts`, `README.md`, `manifest.json`, `package.json`, `package-lock.json`

**Interfaces:**
- Consumes:
  - `backfill`, `delta` (Task 3);
  - `dossierPass`, `isPassDue` (Task 6);
  - `DOSSIER_DOC_TYPE` (Task 5);
  - `CURSOR_VERSION`, `INCREMENTAL_TYPES` (Task 1).
- Produces: `UPGRADE_MESSAGE` export; descriptor `documentTypes` = incremental doc types + `hubspot.dossier` + `file`.

- [ ] **Step 1: Write the failing tests** — in `src/__tests__/source.test.ts`

- descriptor test: replace `toContain('hubspot.contact')` with
  ```ts
  expect(src.descriptor.documentTypes).toContain('hubspot.dossier');
  expect(src.descriptor.documentTypes).not.toContain('hubspot.contact');
  expect(src.descriptor.documentTypes).not.toContain('hubspot.task');
  ```
- in `describe('pull dispatch')` append:
  ```ts
  it('refuses a v0.1 cursor with a permanent error', async () => {
    const src = createHubSpotSource(makeHost(() => ({ results: [] })), clock);
    const old = { phase: 'live', watermarks: {} } as never;
    const iter = src.pull(session(), old)[Symbol.asyncIterator]();
    await expect(iter.next()).rejects.toBeInstanceOf(SourcePermanentError);
    await expect(src.pull(session(), old)[Symbol.asyncIterator]().next()).rejects.toThrow(UPGRADE_MESSAGE);
  });

  it('resumes an interrupted v2 backfill without the permanent error', async () => {
    const src = createHubSpotSource(makeHost(() => ({ results: [] })), clock);
    const mid = { v: 2, phase: 'backfill', step: 'notes', after: 'N2', watermarks: { deals: '2026-01-01T00:00:00.000Z' }, backfillStartedAt: '2026-01-01T00:00:00.000Z' } as never;
    const phases: string[] = [];
    for await (const b of src.pull(session(), mid)) phases.push(b.phase);
    expect(phases[phases.length - 1]).toBe('live');
  });

  it('null cursor → backfill, then a dossier pass in the same pull', async () => {
    const src = createHubSpotSource(makeHost(() => ({ results: [] })), clock);
    const cursors: Array<{ dossier?: { lastCompletedAt: string | null } }> = [];
    for await (const b of src.pull(session(), null)) cursors.push(b.cursor as never);
    expect(cursors[cursors.length - 1].dossier?.lastCompletedAt).toEqual(expect.any(String));
  });

  it('skips the pass when it is not due', async () => {
    const urls: string[] = [];
    const src = createHubSpotSource(makeHost((url) => { urls.push(url); return { results: [] }; }), clock);
    const recent = new Date().toISOString();
    const cursor = {
      v: 2, phase: 'live',
      watermarks: { deals: recent, tickets: recent, notes: recent, calls: recent, meetings: recent, emails: recent },
      dossier: { lastCompletedAt: recent, attemptedAt: recent, scopes: {}, counts: {} },
    } as never;
    for await (const _ of src.pull(session(), cursor)) { /* drain */ }
    expect(urls.some((u) => /objects\/contacts\?/.test(u))).toBe(false);
  });
  ```
  Import `SourcePermanentError` from `'@kiagent/connector-sdk'` and `UPGRADE_MESSAGE` from `'../source'`.

  The `clock` fixture's `now` starts at 1000 ms (1970), so for 'skips the pass when it is not due' the source must use real `Date.now()` for pass scheduling, not `clock.now`. See Step 3.

- [ ] **Step 2: Run to verify they fail**

Run: `npx jest src/__tests__/source.test.ts 2>&1 | tail -20`
Expected: FAIL — the descriptor still lists `hubspot.contact`, `UPGRADE_MESSAGE` is undefined, and there's no permanent error.

- [ ] **Step 3: Implement** — `src/source.ts`

- imports: `SourcePermanentError` from `'@kiagent/connector-sdk'`; `{ dossierPass, isPassDue }` from `'./dossier/pass'`; `{ DOSSIER_DOC_TYPE }` from `'./dossier/layout'`; `CURSOR_VERSION`, `INCREMENTAL_TYPES` from `'./types'` (drop `ALL_TYPES`);
- add:
  ```ts
  export const UPGRADE_MESSAGE = 'Remove and re-add the HubSpot account to upgrade to dossiers';
  ```
- descriptor: `documentTypes: [...INCREMENTAL_TYPES.map((t) => DOC_TYPE[t]), DOSSIER_DOC_TYPE, 'file'],`
- `pull` becomes:
  ```ts
  async *pull(session: Session, cursor: HubSpotCursor | null) {
    // Spec §6: v0.1 cursors index contacts/companies/tasks as standalone docs
    // that nothing in v0.2 deletes — refuse instead of duplicating them.
    if (cursor !== null && (cursor as { v?: unknown }).v !== CURSOR_VERSION) {
      throw new SourcePermanentError(UPGRADE_MESSAGE);
    }
    const token = await requireToken(session);
    const client = makeClient(token);
    const portalId = String(session.account.config.portalId ?? '');
    const ctx = await fetchRenderContext(client, portalId);
    let latest: HubSpotCursor | null = cursor;
    const incremental =
      cursor === null || cursor.phase === 'backfill'
        ? backfill(client, session, cursor, ctx)
        : delta(client, session, cursor, ctx);
    for await (const batch of incremental) {
      latest = batch.cursor;
      yield batch;
    }
    if (session.signal.aborted || latest === null || latest.phase !== 'live') return;
    // Wall clock on purpose: `clock` only paces the HTTP throttle in tests.
    const now = Date.now();
    if (!isPassDue(latest.dossier, now)) return;
    yield* dossierPass(client, session, latest, ctx, now);
  },
  ```
  (`backfill`'s parameter type is `Extract<HubSpotCursor, {phase:'backfill'}> | null`. Narrowing via `cursor.phase === 'backfill'` already holds.)

`README.md`:
- replace the "One document per **contact, company, deal, ticket**" bullet and the engagement-parent bullet (lines ~29–35) with a description of:
  - dossiers (per email domain / company / "Individuals — month" / "Unassigned activity — month", ≤ 8,000 chars per part, rebuilt every 6 h);
  - standalone docs for deals, tickets, notes, calls, meetings, incoming and attached emails, and files (no parent; related records linked in the body);
- add a section:
  ```md
  ## Upgrading from 0.1.x

  0.2.0 changes how HubSpot is indexed (contacts, companies, sequence emails and
  tasks are folded into per-organisation dossiers). Remove the HubSpot account,
  update the connector from the Marketplace, then add the account again. An
  account left in place shows "Remove and re-add the HubSpot account to upgrade
  to dossiers".
  ```

Version: set `"version": "0.2.0"` in `manifest.json`, `package.json`, and the two top-level entries of `package-lock.json` (`"version"` at the root and under `packages[""]`).

- [ ] **Step 4: Run the whole suite, typecheck and build**

Run: `npx jest 2>&1 | tail -25 && npx tsc --noEmit && npm run build 2>&1 | tail -5`
Expected:
- all suites PASS;
- `tsc` prints nothing. Fix any leftover `ALL_TYPES`/`TypeKey` mismatches it reports in `backfill.ts`/`delta.ts`/tests by switching to `IncrementalTypeKey`;
- the build writes `dist/index.js`.

- [ ] **Step 5: Commit**

```bash
git add src/source.ts src/__tests__/source.test.ts README.md manifest.json package.json package-lock.json
git commit -m "feat: domain dossiers v0.2.0 — wire the pass, refuse v0.1 cursors"
```

---

## Self-Review notes

- **Spec coverage:**

  | Spec section | Task |
  |---|---|
  | §1 split + parents | Tasks 1–3 |
  | §2 scopes | Task 4 |
  | §3 layout / bounds / no totals | Task 5 |
  | §4 pass, chunks, high-water, final batch, shrink guard, attemptedAt/retry | Task 6 |
  | Cursor preservation | Task 3 |
  | §6 migration gate + README | Task 7 |

  §5 is behavioural, with no code.
- **Deferred by spec:** resumable passes, attachment-membership tracking.
