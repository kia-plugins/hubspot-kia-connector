# HubSpot Connector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A KIAgent extension that indexes a HubSpot portal (contacts, companies, deals, tickets, emails, notes, calls, meetings, tasks, engagement attachments) into local KIAgent memory with incremental sync.

**Architecture:** Extension Platform plugin — a TypeScript CJS bundle whose `activate(host)` returns one Source contribution (`connect`/`pull`/`toDocument`/`fetchBytes`). Phased list-endpoint backfill (objects before engagements), search-API delta with per-type watermarks and a request budget, archived-listing sweep for deletions. All HTTP via `host.net.fetch`.

**Tech Stack:** TypeScript strict / CommonJS / es2022 / node20, esbuild bundle, jest + ts-jest. Zero runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-07-16-hubspot-connector-design.md` — read it before starting any task.

## Global Constraints

- Repo root: `/Users/edjafarov/work/hubspot-kia-connector` (git repo already initialized, spec committed on `main`).
- Reference clones (read-only templates — copy boilerplate from here): `/private/tmp/claude-501/-Users-edjafarov-work-kiagent-core/799dded0-35cb-4dc8-b4c8-750cacc72c46/scratchpad/notion-kia-connector` and `.../slack-kia-connector`. If missing, re-clone: `git clone --depth 1 https://github.com/kia-plugins/notion-kia-connector <dir>`.
- `src/kiagent-contracts.ts` is a vendored snapshot of kiagent-core `src/shared/contracts.ts` @ commit `6ae78e7` — NEVER edit it.
- Zero runtime dependencies; devDeps exactly: `@types/jest ^29.5.0`, `@types/node ^20.11.0`, `esbuild ^0.24.0`, `jest ^29.7.0`, `ts-jest ^29.2.0`, `typescript ^5.6.0`.
- `manifest.json` version and `package.json` version stay in lockstep at `0.1.0`.
- All HTTP through the injected `NetFetch` (host `net.fetch`) — never global `fetch`. Host responses are `{ status, statusText, headers (lowercase keys), body: Uint8Array }` — no `.ok`, parse JSON via `JSON.parse(new TextDecoder().decode(body))`.
- Every yielded cursor object must be freshly built or `structuredClone`d — never a mutated shared reference.
- `session.signal` checked in every loop; on abort, `return`.
- Auth errors (HTTP 401/403) always propagate out of `pull`; per-record failures are `session.log('warn', …)` + skip.
- Commit after every green test cycle. Conventional commit messages (`feat:`, `test:`, `chore:`, `docs:`).
- Verification before completion: `npm test` and `npm run typecheck` must pass before every commit claim.

---

### Task 1: Scaffold repo boilerplate

**Files:**
- Create: `package.json`, `manifest.json`, `build.mjs`, `tsconfig.json`, `jest.config.js`, `.gitignore`, `LICENSE`, `src/kiagent-contracts.ts`, `scripts/make-icon.mjs`, `icon.png`

**Interfaces:**
- Produces: the vendored SDK types every later task imports from `./kiagent-contracts` (`Source`, `Batch`, `Session`, `AuthChannel`, `DocumentInput`, `ExternalRef`, `HostFor`, `ExtensionModule`, `Document`).

- [ ] **Step 1: Copy byte-identical boilerplate from the notion clone**

```bash
cd /Users/edjafarov/work/hubspot-kia-connector
N=/private/tmp/claude-501/-Users-edjafarov-work-kiagent-core/799dded0-35cb-4dc8-b4c8-750cacc72c46/scratchpad/notion-kia-connector
cp "$N/build.mjs" "$N/tsconfig.json" "$N/jest.config.js" "$N/.gitignore" "$N/LICENSE" .
mkdir -p src scripts
```

- [ ] **Step 2: Vendor the contracts**

```bash
cp /Users/edjafarov/work/kiagent-core/src/shared/contracts.ts src/kiagent-contracts.ts
```

Then prepend this header comment to `src/kiagent-contracts.ts` (above the existing content):

```ts
/**
 * Vendored snapshot of kiagent-core src/shared/contracts.ts @ 6ae78e7 —
 * the contract IS the SDK; do not edit, re-vendor.
 */
```

- [ ] **Step 3: Write `package.json`**

```json
{
  "name": "hubspot-kia-connector",
  "version": "0.1.0",
  "private": true,
  "description": "HubSpot connector for KIAgent (extension platform)",
  "files": [
    "manifest.json",
    "dist",
    "README.md",
    "icon.png"
  ],
  "scripts": {
    "build": "node build.mjs",
    "test": "jest",
    "typecheck": "tsc --noEmit"
  },
  "devDependencies": {
    "@types/jest": "^29.5.0",
    "@types/node": "^20.11.0",
    "esbuild": "^0.24.0",
    "jest": "^29.7.0",
    "ts-jest": "^29.2.0",
    "typescript": "^5.6.0"
  }
}
```

- [ ] **Step 4: Write `manifest.json`**

```json
{
  "id": "kia.hubspot",
  "name": "HubSpot",
  "version": "0.1.0",
  "engine": "^1.0.0",
  "entry": "dist/index.js",
  "caps": [
    "net"
  ],
  "contributes": {
    "sources": [
      "hubspot"
    ]
  },
  "icon": "icon.png"
}
```

- [ ] **Step 5: Generate the placeholder icon**

Write `scripts/make-icon.mjs` (solid HubSpot-orange 128×128 PNG — a neutral placeholder, deliberately NOT the HubSpot logo):

```js
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';

const W = 128;
const H = 128;
const crcTable = [...Array(256)].map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // RGBA
const raw = Buffer.alloc(H * (1 + W * 4));
for (let y = 0; y < H; y++) {
  const o = y * (1 + W * 4);
  for (let x = 0; x < W; x++) {
    const p = o + 1 + x * 4;
    raw[p] = 0xff; raw[p + 1] = 0x7a; raw[p + 2] = 0x59; raw[p + 3] = 0xff;
  }
}
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw)),
  chunk('IEND', Buffer.alloc(0)),
]);
writeFileSync(new URL('../icon.png', import.meta.url), png);
```

Run: `node scripts/make-icon.mjs` — creates `icon.png` (<1 KB).

- [ ] **Step 6: Install and verify**

```bash
npm install
npm run typecheck
```

Expected: typecheck passes (only the vendored contracts exist under `src/`).

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "chore: scaffold extension boilerplate, vendor contracts @ 6ae78e7"
```

---

### Task 2: Type constants and the HubSpot API client

**Files:**
- Create: `src/types.ts`, `src/client.ts`
- Test: `src/__tests__/client.test.ts`

**Interfaces:**
- Consumes: `ExternalRef` from `./kiagent-contracts`.
- Produces:
  - `types.ts`: `OBJECT_TYPES`, `ENGAGEMENT_TYPES`, `ALL_TYPES`, `ObjectTypeKey`, `EngagementTypeKey`, `TypeKey`, `DOC_TYPE: Record<TypeKey, string>`, `OBJECT_TYPE_ID: Record<ObjectTypeKey, string>`, `LAST_MODIFIED_PROP: Record<TypeKey, string>`, `HubSpotRecord`, `Associations`, `RenderContext`, `HubSpotItem`, `HubSpotCursor`, `ListEnvelope`, `SearchEnvelope`.
  - `client.ts`: `class HubSpotClient { constructor(deps: HubSpotClientDeps); requestCount: number; request<T>(method, pathname, body?): Promise<T>; download(url): Promise<{ bytes: Uint8Array; mime: string }> }`, `class HubSpotApiError extends Error { httpStatus: number; category: string }`, `isAuthError(e): boolean`, `type NetFetch`, `interface HubSpotClientDeps { fetch: NetFetch; token: string; sleep?; now? }`, `HUBSPOT_API_BASE = 'https://api.hubapi.com'`.

- [ ] **Step 1: Write `src/types.ts`** (types are compile-checked; the constant maps get asserted in the client test file)

```ts
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
      /** null when the file exceeds MAX_FILE_BYTES or download failed. */
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
```

- [ ] **Step 2: Write the failing client test** — `src/__tests__/client.test.ts`

```ts
import { HubSpotApiError, HubSpotClient, isAuthError, HUBSPOT_API_BASE } from '../client';
import { ALL_TYPES, DOC_TYPE, LAST_MODIFIED_PROP } from '../types';

const enc = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));
const res = (status: number, body: unknown, headers: Record<string, string> = {}) => ({
  status,
  statusText: '',
  headers,
  body: enc(body),
});

function makeClient(responses: Array<ReturnType<typeof res>>, calls: Array<{ url: string; init: any }> = []) {
  let i = 0;
  const sleeps: number[] = [];
  const client = new HubSpotClient({
    fetch: async (url, init) => {
      calls.push({ url, init });
      if (i >= responses.length) throw new Error('unexpected extra request');
      return responses[i++];
    },
    token: 'pat-na1-test',
    sleep: async (ms) => { sleeps.push(ms); },
    now: (() => { let t = 0; return () => (t += 1000); })(),
  });
  return { client, sleeps, calls };
}

describe('type maps', () => {
  it('covers every type key', () => {
    for (const t of ALL_TYPES) {
      expect(DOC_TYPE[t]).toMatch(/^hubspot\./);
      expect(LAST_MODIFIED_PROP[t]).toBe(t === 'contacts' ? 'lastmodifieddate' : 'hs_lastmodifieddate');
    }
  });
});

describe('HubSpotClient.request', () => {
  it('sends bearer auth and parses JSON', async () => {
    const calls: Array<{ url: string; init: any }> = [];
    const { client } = makeClient([res(200, { portalId: 123 })], calls);
    const out = await client.request<{ portalId: number }>('GET', '/account-info/v3/details');
    expect(out.portalId).toBe(123);
    expect(calls[0].url).toBe(`${HUBSPOT_API_BASE}/account-info/v3/details`);
    expect(calls[0].init.headers.authorization).toBe('Bearer pat-na1-test');
    expect(client.requestCount).toBe(1);
  });

  it('retries 429 honoring retry-after (clamped), then succeeds', async () => {
    const { client, sleeps } = makeClient([
      res(429, {}, { 'retry-after': '2' }),
      res(429, {}, { 'retry-after': '999' }),
      res(200, { ok: true }),
    ]);
    await client.request('GET', '/x');
    expect(sleeps).toContain(2000);
    expect(sleeps).toContain(60000); // 999 clamped to 60s
  });

  it('retries 5xx with exponential backoff and gives up after 4 retries', async () => {
    const { client } = makeClient(Array.from({ length: 5 }, () => res(500, {})));
    await expect(client.request('GET', '/x')).rejects.toThrow(/HTTP 500 after 5 attempts/);
  });

  it('throws HubSpotApiError with category on 4xx and tags auth errors', async () => {
    const { client } = makeClient([res(401, { category: 'INVALID_AUTHENTICATION', message: 'bad token' })]);
    try {
      await client.request('GET', '/x');
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(HubSpotApiError);
      expect((e as HubSpotApiError).httpStatus).toBe(401);
      expect(isAuthError(e)).toBe(true);
    }
    expect(isAuthError(new Error('nope'))).toBe(false);
  });

  it('POSTs a JSON body', async () => {
    const calls: Array<{ url: string; init: any }> = [];
    const { client } = makeClient([res(200, { results: [] })], calls);
    await client.request('POST', '/crm/v3/objects/contacts/search', { limit: 100 });
    expect(calls[0].init.method).toBe('POST');
    expect(JSON.parse(calls[0].init.body)).toEqual({ limit: 100 });
  });
});

describe('HubSpotClient.download', () => {
  it('fetches an absolute URL without auth and returns bytes + mime', async () => {
    const calls: Array<{ url: string; init: any }> = [];
    const { client } = makeClient(
      [{ status: 200, statusText: '', headers: { 'content-type': 'application/pdf' }, body: new Uint8Array([1, 2, 3]) }],
      calls,
    );
    const out = await client.download('https://signed.example/f.pdf');
    expect(Array.from(out.bytes)).toEqual([1, 2, 3]);
    expect(out.mime).toBe('application/pdf');
    expect(calls[0].url).toBe('https://signed.example/f.pdf');
    expect(calls[0].init?.headers?.authorization).toBeUndefined();
  });

  it('throws on non-2xx download', async () => {
    const { client } = makeClient([{ status: 403, statusText: '', headers: {}, body: new Uint8Array() }]);
    await expect(client.download('https://signed.example/f.pdf')).rejects.toThrow(/403/);
  });
});
```

- [ ] **Step 2b: Run to verify it fails**

Run: `npx jest src/__tests__/client.test.ts`
Expected: FAIL — `Cannot find module '../client'`.

- [ ] **Step 3: Write `src/client.ts`**

Structural copy of the notion client with HubSpot constants. Same retry ladder; adds `category` (HubSpot's error field) instead of notion's `code`, and a `download()` for signed-URL file bytes.

```ts
export type NetFetch = (url: string, init?: unknown) => Promise<unknown>;

export const HUBSPOT_API_BASE = 'https://api.hubapi.com';
/** Private-app burst limit is ≥100 req/10 s and search is capped at 5 req/s;
 *  a single global 3 rps throttle stays safely under both. */
export const REQUESTS_PER_SECOND = 3;
const MIN_INTERVAL_MS = Math.ceil(1000 / REQUESTS_PER_SECOND);
const MAX_TRANSIENT_RETRIES = 4;
const TRANSIENT_BACKOFF_MS = 1_000; // 1s, 2s, 4s, 8s
const MAX_RATE_LIMIT_RETRIES = 5;

/** The host `net.fetch` surface resolves to this shape — header keys lowercase. */
interface HostResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: Uint8Array;
}

export class HubSpotApiError extends Error {
  constructor(
    public httpStatus: number,
    public category: string,
    message: string,
  ) {
    super(`hubspot ${category}: ${message}`);
    this.name = 'HubSpotApiError';
  }
}

/** 401 = bad/revoked token, 403 = missing scope — both need the user to fix
 *  the Private App, so both flip the account to needsReauth. */
export const isAuthError = (e: unknown): boolean =>
  e instanceof HubSpotApiError && (e.httpStatus === 401 || e.httpStatus === 403);

export interface HubSpotClientDeps {
  fetch: NetFetch;
  token: string;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export class HubSpotClient {
  requestCount = 0;

  private lastCallAt = 0;

  private readonly fetchFn: NetFetch;

  private readonly sleepFn: (ms: number) => Promise<void>;

  private readonly now: () => number;

  constructor(private readonly deps: HubSpotClientDeps) {
    this.fetchFn = deps.fetch;
    this.sleepFn = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = deps.now ?? Date.now;
  }

  private async throttle(): Promise<void> {
    const wait = this.lastCallAt + MIN_INTERVAL_MS - this.now();
    if (wait > 0) await this.sleepFn(wait);
    this.lastCallAt = this.now();
    this.requestCount += 1;
  }

  private async raw(url: string, init: Record<string, unknown>): Promise<HostResponse> {
    let transient = 0;
    let rateLimited = 0;
    for (;;) {
      await this.throttle();
      let res: HostResponse;
      try {
        res = (await this.fetchFn(url, init)) as HostResponse;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (transient >= MAX_TRANSIENT_RETRIES)
          throw new Error(`hubspot ${url}: network error after ${transient + 1} attempts: ${msg}`);
        transient += 1;
        await this.sleepFn(TRANSIENT_BACKOFF_MS * 2 ** (transient - 1));
        continue;
      }
      if (res.status === 429) {
        if (rateLimited >= MAX_RATE_LIMIT_RETRIES)
          throw new Error(`hubspot ${url}: HTTP 429 after ${rateLimited + 1} attempts`);
        rateLimited += 1;
        // retry-after may be missing or non-numeric; default 5s, floor 1s, cap 60s.
        const rawHeader = Number(res.headers['retry-after']);
        const after = Number.isFinite(rawHeader) ? Math.min(Math.max(1, rawHeader), 60) : 5;
        await this.sleepFn(after * 1000);
        continue;
      }
      if (res.status >= 500) {
        if (transient >= MAX_TRANSIENT_RETRIES)
          throw new Error(`hubspot ${url}: HTTP ${res.status} after ${transient + 1} attempts`);
        transient += 1;
        await this.sleepFn(TRANSIENT_BACKOFF_MS * 2 ** (transient - 1));
        continue;
      }
      return res;
    }
  }

  async request<T = unknown>(method: 'GET' | 'POST', pathname: string, body?: unknown): Promise<T> {
    const res = await this.raw(`${HUBSPOT_API_BASE}${pathname}`, {
      method,
      headers: {
        authorization: `Bearer ${this.deps.token}`,
        'content-type': 'application/json',
      },
      body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
    });
    const json = JSON.parse(new TextDecoder().decode(res.body)) as T & {
      category?: string;
      message?: string;
    };
    if (res.status < 200 || res.status >= 300)
      throw new HubSpotApiError(res.status, json.category ?? 'unknown_error', json.message ?? `HTTP ${res.status}`);
    return json;
  }

  /** Fetch an absolute (signed) URL with NO auth header; returns raw bytes. */
  async download(url: string): Promise<{ bytes: Uint8Array; mime: string }> {
    const res = await this.raw(url, { method: 'GET' });
    if (res.status < 200 || res.status >= 300)
      throw new Error(`hubspot file download: HTTP ${res.status}`);
    return { bytes: res.body, mime: res.headers['content-type'] ?? 'application/octet-stream' };
  }
}
```

- [ ] **Step 4: Run tests**

Run: `npx jest src/__tests__/client.test.ts` — Expected: PASS. Then `npm run typecheck` — PASS.

- [ ] **Step 5: Commit**

```bash
git add src/types.ts src/client.ts src/__tests__/client.test.ts
git commit -m "feat: type constants and rate-limited HubSpot client"
```

---

### Task 3: HTML-to-text renderer and property formatting

**Files:**
- Create: `src/render.ts`
- Test: `src/__tests__/render.test.ts`

**Interfaces:**
- Produces: `htmlToText(html: string): string`, `propLines(pairs: Array<[label: string, value: string | null | undefined]>): string` (skips empty values, returns `**Label:** value` lines joined by `\n`), `truncate(s: string, n: number): string`.

- [ ] **Step 1: Write the failing test** — `src/__tests__/render.test.ts`

```ts
import { htmlToText, propLines, truncate } from '../render';

describe('htmlToText', () => {
  it('strips tags and preserves line structure', () => {
    expect(htmlToText('<p>Hello <b>world</b></p><p>Second</p>')).toBe('Hello world\n\nSecond');
    expect(htmlToText('a<br>b<br/>c')).toBe('a\nb\nc');
    expect(htmlToText('<ul><li>one</li><li>two</li></ul>')).toBe('- one\n- two');
  });

  it('decodes common entities (whitespace collapses within a line)', () => {
    expect(htmlToText('Fish &amp; Chips &lt;3 &quot;yes&quot; &#39;no&#39; &nbsp;!')).toBe(
      'Fish & Chips <3 "yes" \'no\' !',
    );
  });

  it('drops style/script blocks and collapses blank runs to one paragraph gap', () => {
    expect(htmlToText('<style>p{color:red}</style><div>x</div>\n\n\n\n<div>y</div>')).toBe('x\n\ny');
  });

  it('passes plain text through', () => {
    expect(htmlToText('already plain')).toBe('already plain');
  });
});

describe('propLines', () => {
  it('renders only non-empty values', () => {
    expect(
      propLines([
        ['Email', 'a@b.c'],
        ['Phone', ''],
        ['City', null],
        ['Owner', undefined],
        ['Stage', 'Won'],
      ]),
    ).toBe('**Email:** a@b.c\n**Stage:** Won');
  });
});

describe('truncate', () => {
  it('cuts long strings with an ellipsis', () => {
    expect(truncate('abcdef', 4)).toBe('abc…');
    expect(truncate('abc', 4)).toBe('abc');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx jest src/__tests__/render.test.ts` — Expected: FAIL, module not found.

- [ ] **Step 3: Write `src/render.ts`**

```ts
/** Minimal, dependency-free HTML → text. Same altitude as slack's message
 *  rendering: engagement bodies are simple editor/email HTML, not arbitrary
 *  web pages — structure (<p>, <br>, <li>) becomes line breaks, everything
 *  else is stripped. */
export function htmlToText(html: string): string {
  let s = html;
  s = s.replace(/<(style|script)[^>]*>[\s\S]*?<\/\1>/gi, '');
  s = s.replace(/<\s*li[^>]*>/gi, '\n- ');
  s = s.replace(/<\s*br\s*\/?\s*>/gi, '\n');
  s = s.replace(/<\s*\/(p|div|ul|ol|h[1-6]|tr|table|blockquote)\s*>/gi, '\n\n');
  s = s.replace(/<[^>]+>/g, '');
  s = s
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&amp;/g, '&');
  const lines = s.split('\n').map((l) => l.replace(/\s+/g, ' ').trim());
  const out: string[] = [];
  let blanks = 0;
  for (const line of lines) {
    if (line === '') {
      blanks += 1;
      if (blanks > 1 || out.length === 0) continue;
    } else {
      blanks = 0;
    }
    out.push(line);
  }
  while (out.length > 0 && out[out.length - 1] === '') out.pop();
  return out.join('\n');
}

export function propLines(pairs: Array<[string, string | null | undefined]>): string {
  return pairs
    .filter((p): p is [string, string] => typeof p[1] === 'string' && p[1] !== '')
    .map(([label, value]) => `**${label}:** ${value}`)
    .join('\n');
}

export function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
```

- [ ] **Step 4: Run tests**

Run: `npx jest src/__tests__/render.test.ts` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/render.ts src/__tests__/render.test.ts
git commit -m "feat: pure html-to-text and property rendering helpers"
```

---

### Task 4: Property lists and pull-time lookups

**Files:**
- Create: `src/properties.ts`, `src/lookups.ts`
- Test: `src/__tests__/lookups.test.ts`

**Interfaces:**
- Consumes: `HubSpotClient` (Task 2), `TypeKey`, `RenderContext`, `ALL_TYPES`, `OBJECT_TYPES` (Task 2).
- Produces:
  - `properties.ts`: `STANDARD_PROPS: Record<TypeKey, string[]>`, `propsFor(type: TypeKey, ctx: RenderContext): string[]` (standard + custom names, deduped).
  - `lookups.ts`: `fetchRenderContext(client: HubSpotClient, portalId: string): Promise<RenderContext>`, `ownerLabel(ctx: RenderContext, ownerId: string | null | undefined): string | null`.

- [ ] **Step 1: Write `src/properties.ts`** (pure data — covered by the lookups test)

```ts
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
```

- [ ] **Step 2: Write the failing lookups test** — `src/__tests__/lookups.test.ts`

The stub client maps pathnames to canned envelopes (a plain object standing in for `HubSpotClient` — `fetchRenderContext` accepts anything with `.request`; type the parameter as `Pick<HubSpotClient, 'request'>`).

```ts
import { fetchRenderContext, ownerLabel } from '../lookups';
import { propsFor } from '../properties';

const routes: Record<string, unknown> = {
  '/crm/v3/owners/?limit=100': {
    results: [
      { id: '9', firstName: 'Ada', lastName: 'Lovelace', email: 'ada@x.co' },
      { id: '10', firstName: '', lastName: '', email: 'bot@x.co' },
    ],
  },
  '/crm/v3/pipelines/deals': {
    results: [
      { id: 'default', label: 'Sales', stages: [{ id: 's1', label: 'Qualified' }, { id: 's2', label: 'Won' }] },
    ],
  },
  '/crm/v3/pipelines/tickets': {
    results: [{ id: 'tp', label: 'Support', stages: [{ id: 't1', label: 'New' }] }],
  },
};

const stubClient = {
  request: async <T>(_m: string, pathname: string): Promise<T> => {
    if (pathname.startsWith('/crm/v3/properties/')) {
      const type = pathname.split('/').pop();
      return (
        type === 'contacts'
          ? { results: [{ name: 'favorite_color', label: 'Favorite color', hubspotDefined: false }, { name: 'email', label: 'Email', hubspotDefined: true }] }
          : { results: [] }
      ) as T;
    }
    const hit = routes[pathname];
    if (!hit) throw new Error(`unexpected path ${pathname}`);
    return hit as T;
  },
};

describe('fetchRenderContext', () => {
  it('builds owners, stage labels, and custom-prop maps', async () => {
    const ctx = await fetchRenderContext(stubClient as never, '123');
    expect(ctx.portalId).toBe('123');
    expect(ctx.owners['9']).toEqual({ name: 'Ada Lovelace', email: 'ada@x.co' });
    expect(ctx.owners['10'].name).toBe('bot@x.co'); // nameless owner falls back to email
    expect(ctx.dealStages['s2']).toEqual({ pipeline: 'Sales', stage: 'Won' });
    expect(ctx.ticketStages['t1']).toEqual({ pipeline: 'Support', stage: 'New' });
    expect(ctx.customProps.contacts).toEqual({ favorite_color: 'Favorite color' });
    expect(ctx.customProps.deals).toEqual({});
  });

  it('propsFor merges standard and custom names without dupes', async () => {
    const ctx = await fetchRenderContext(stubClient as never, '123');
    const props = propsFor('contacts', ctx);
    expect(props).toContain('favorite_color');
    expect(props).toContain('email');
    expect(new Set(props).size).toBe(props.length);
  });
});

describe('ownerLabel', () => {
  it('resolves and degrades gracefully', async () => {
    const ctx = await fetchRenderContext(stubClient as never, '123');
    expect(ownerLabel(ctx, '9')).toBe('Ada Lovelace');
    expect(ownerLabel(ctx, '404')).toBe(null);
    expect(ownerLabel(ctx, null)).toBe(null);
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx jest src/__tests__/lookups.test.ts` — Expected: FAIL, `../lookups` not found.

- [ ] **Step 4: Write `src/lookups.ts`**

```ts
import type { HubSpotClient } from './client';
import { ALL_TYPES, type RenderContext, type TypeKey } from './types';

interface OwnersEnvelope {
  results?: Array<{ id: string; firstName?: string; lastName?: string; email?: string }>;
  paging?: { next?: { after?: string } };
}

interface PipelinesEnvelope {
  results?: Array<{ id: string; label: string; stages?: Array<{ id: string; label: string }> }>;
}

interface PropertiesEnvelope {
  results?: Array<{ name: string; label?: string; hubspotDefined?: boolean }>;
}

type Client = Pick<HubSpotClient, 'request'>;

/** One fetch per pull: owners, pipeline/stage labels, custom property names.
 *  Attached to every item so toDocument stays pure. Sizes are small (owners
 *  page ≤100 × few pages, pipelines are tiny, one properties call per type). */
export async function fetchRenderContext(client: Client, portalId: string): Promise<RenderContext> {
  const owners: RenderContext['owners'] = {};
  let after: string | undefined;
  do {
    const page = await client.request<OwnersEnvelope>(
      'GET',
      `/crm/v3/owners/?limit=100${after ? `&after=${encodeURIComponent(after)}` : ''}`,
    );
    for (const o of page.results ?? []) {
      const name = [o.firstName, o.lastName].filter(Boolean).join(' ').trim();
      owners[o.id] = { name: name || o.email || `owner ${o.id}`, email: o.email };
    }
    after = page.paging?.next?.after;
  } while (after);

  const stageMap = async (kind: 'deals' | 'tickets') => {
    const out: Record<string, { pipeline: string; stage: string }> = {};
    const page = await client.request<PipelinesEnvelope>('GET', `/crm/v3/pipelines/${kind}`);
    for (const p of page.results ?? [])
      for (const s of p.stages ?? []) out[s.id] = { pipeline: p.label, stage: s.label };
    return out;
  };

  const customProps: RenderContext['customProps'] = {};
  for (const type of ALL_TYPES) {
    const page = await client.request<PropertiesEnvelope>('GET', `/crm/v3/properties/${type}`);
    const map: Record<string, string> = {};
    for (const p of page.results ?? [])
      if (p.hubspotDefined === false) map[p.name] = p.label ?? p.name;
    customProps[type] = map;
  }

  return {
    portalId,
    owners,
    dealStages: await stageMap('deals'),
    ticketStages: await stageMap('tickets'),
    customProps,
  };
}

export function ownerLabel(ctx: RenderContext, ownerId: string | null | undefined): string | null {
  if (!ownerId) return null;
  return ctx.owners[ownerId]?.name ?? null;
}
```

- [ ] **Step 5: Run tests**

Run: `npx jest src/__tests__/lookups.test.ts` — Expected: PASS. `npm run typecheck` — PASS.

- [ ] **Step 6: Commit**

```bash
git add src/properties.ts src/lookups.ts src/__tests__/lookups.test.ts
git commit -m "feat: property lists and pull-time render-context lookups"
```

---

### Task 5: Document rendering — CRM objects

**Files:**
- Create: `src/docs.ts`, `src/testing/fixtures.ts` (shared test fixture — deliberately OUTSIDE `src/__tests__/` because jest's default testMatch treats every file under `__tests__` as a test suite; it is only imported by tests, so it never reaches the bundle, which is built from `src/index.ts`)
- Test: `src/__tests__/docs-objects.test.ts`

**Interfaces:**
- Consumes: `htmlToText`, `propLines`, `truncate` (Task 3), `ownerLabel` (Task 4), types from Task 2.
- Produces: `renderItem(item: HubSpotItem): DocumentInput | DocumentInput[] | null` — PURE; plus internal helpers. `recordUrl(ctx, objectType, id): string`. `primaryParent(assoc: Associations): ExternalRef | null` (priority contacts > deals > tickets > companies) — exported for delta/backfill tests.

- [ ] **Step 1: Write the shared fixture** — `src/testing/fixtures.ts`

```ts
import type { RenderContext } from '../types';

export const ctx: RenderContext = {
  portalId: '123',
  owners: { '9': { name: 'Ada Lovelace', email: 'ada@x.co' } },
  dealStages: { s2: { pipeline: 'Sales', stage: 'Won' } },
  ticketStages: { t1: { pipeline: 'Support', stage: 'New' } },
  customProps: { contacts: { favorite_color: 'Favorite color' } },
};
```

- [ ] **Step 1b: Write the failing test** — `src/__tests__/docs-objects.test.ts`

```ts
import { primaryParent, recordUrl, renderItem } from '../docs';
import type { DocumentInput } from '../kiagent-contracts';
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx jest src/__tests__/docs-objects.test.ts` — Expected: FAIL, `../docs` not found.

- [ ] **Step 3: Write `src/docs.ts`** (object half; engagement/file branches land in Task 6 — for now they `return null`)

```ts
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
```

- [ ] **Step 4: Run tests**

Run: `npx jest src/__tests__/docs-objects.test.ts` — Expected: PASS. `npm run typecheck` — PASS.

- [ ] **Step 5: Commit**

```bash
git add src/docs.ts src/testing/fixtures.ts src/__tests__/docs-objects.test.ts
git commit -m "feat: pure document rendering for CRM objects"
```

---

### Task 6: Document rendering — engagements and files

**Files:**
- Modify: `src/docs.ts` (replace the `return null` engagement/file branches)
- Test: `src/__tests__/docs-engagements.test.ts`

**Interfaces:**
- Consumes: everything from Task 5 (same file).
- Produces: `renderItem` handles all nine kinds plus `kind: 'file'`. Engagement docs carry `parent` from `primaryParent(assoc)`, `url` of the parent record (or undefined when parentless), `metadata.hubspot_engagement_type`. Email docs add `metadata.direction`, `metadata.from`, `metadata.to`. File items map to `{ externalId: fileId, type: 'file', markdown: null, binary?: {...}, parent, metadata.hubspot_file_id, metadata.size, metadata.extraction_status? }`.

- [ ] **Step 1: Write the failing test** — `src/__tests__/docs-engagements.test.ts`

```ts
import { renderItem } from '../docs';
import type { DocumentInput } from '../kiagent-contracts';
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
      parent: { externalId: '9002', type: 'hubspot.email' },
      createdAt: '2026-03-03T09:00:00Z',
    });
    expect(doc.type).toBe('file');
    expect(doc.externalId).toBe('f1');
    expect(doc.title).toBe('proposal.pdf');
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
      parent: { externalId: '9001', type: 'hubspot.note' },
      createdAt: null,
    });
    expect(doc.binary).toBeUndefined();
    expect(doc.metadata.extraction_status).toBe('too_large');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx jest src/__tests__/docs-engagements.test.ts` — Expected: FAIL (engagement branch returns null → TypeError on `doc.type`).

- [ ] **Step 3: Implement the engagement + file branches in `src/docs.ts`**

Add below `objectDoc` and replace `renderItem`'s tail:

```ts
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
```

Update the imports at the top of `docs.ts` to include `htmlToText` (from `./render`) and `EngagementTypeKey` (from `./types`).

- [ ] **Step 4: Run tests**

Run: `npx jest src/__tests__/` — Expected: ALL PASS (objects test still green). `npm run typecheck` — PASS.

- [ ] **Step 5: Commit**

```bash
git add src/docs.ts src/__tests__/docs-engagements.test.ts
git commit -m "feat: engagement and attachment document rendering"
```

---

### Task 7: Attachment fetching

**Files:**
- Create: `src/attachments.ts`
- Test: `src/__tests__/attachments.test.ts`

**Interfaces:**
- Consumes: `HubSpotClient` (`request`, `download`), `MAX_FILE_BYTES` (Task 6), types from Task 2, `Session` from contracts.
- Produces: `fetchAttachmentItems(client, session, record: HubSpotRecord, parentDocType: string): Promise<HubSpotItem[]>` — reads `hs_attachment_ids` (semicolon-separated), fetches file metadata + signed URL + bytes for each; oversized → `bytes: null`; a single failed file logs a warning and is skipped. Also `signedUrl(client, fileId): Promise<string>` (used by `fetchBytes` in Task 11).

- [ ] **Step 1: Write the failing test** — `src/__tests__/attachments.test.ts`

```ts
import { fetchAttachmentItems, signedUrl } from '../attachments';
import type { Session } from '../kiagent-contracts';

const session = {
  signal: new AbortController().signal,
  log: jest.fn(),
} as unknown as Session;

function stubClient(overrides: Record<string, unknown> = {}) {
  return {
    request: async <T>(_m: string, pathname: string): Promise<T> => {
      if (pathname === '/files/v3/files/f1') return { id: 'f1', name: 'proposal', extension: 'pdf', size: 1234 } as T;
      if (pathname === '/files/v3/files/f1/signed-url') return { url: 'https://signed.example/f1' } as T;
      if (pathname === '/files/v3/files/f2') return { id: 'f2', name: 'huge', extension: 'mov', size: 99_999_999 } as T;
      if (pathname === '/files/v3/files/f3') throw new Error('boom');
      const hit = overrides[pathname];
      if (hit) return hit as T;
      throw new Error(`unexpected path ${pathname}`);
    },
    download: async (url: string) => {
      expect(url).toBe('https://signed.example/f1');
      return { bytes: new Uint8Array([7]), mime: 'application/pdf' };
    },
  };
}

describe('fetchAttachmentItems', () => {
  it('fetches metadata, signed url, bytes; names include extension', async () => {
    const items = await fetchAttachmentItems(
      stubClient() as never,
      session,
      { id: '9002', properties: { hs_attachment_ids: 'f1', hs_timestamp: '2026-03-03T09:00:00Z' } },
      'hubspot.email',
    );
    expect(items).toHaveLength(1);
    const f = items[0] as Extract<(typeof items)[0], { kind: 'file' }>;
    expect(f.kind).toBe('file');
    expect(f.fileId).toBe('f1');
    expect(f.filename).toBe('proposal.pdf');
    expect(f.mime).toBe('application/pdf');
    expect(Array.from(f.bytes!)).toEqual([7]);
    expect(f.parent).toEqual({ externalId: '9002', type: 'hubspot.email' });
    expect(f.createdAt).toBe('2026-03-03T09:00:00Z');
  });

  it('skips bytes for oversized files, skips failed files with a warning', async () => {
    const items = await fetchAttachmentItems(
      stubClient() as never,
      session,
      { id: '1', properties: { hs_attachment_ids: 'f2;f3' } },
      'hubspot.note',
    );
    expect(items).toHaveLength(1); // f3 skipped entirely
    const f = items[0] as Extract<(typeof items)[0], { kind: 'file' }>;
    expect(f.fileId).toBe('f2');
    expect(f.bytes).toBe(null);
    expect(session.log).toHaveBeenCalledWith('warn', expect.stringContaining('f3'));
  });

  it('returns [] when there are no attachment ids', async () => {
    expect(await fetchAttachmentItems(stubClient() as never, session, { id: '1', properties: {} }, 'hubspot.note')).toEqual([]);
  });
});

describe('signedUrl', () => {
  it('returns the signed download url', async () => {
    expect(await signedUrl(stubClient() as never, 'f1')).toBe('https://signed.example/f1');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx jest src/__tests__/attachments.test.ts` — Expected: FAIL, module not found.

- [ ] **Step 3: Write `src/attachments.ts`**

```ts
import type { HubSpotClient } from './client';
import type { Session } from './kiagent-contracts';
import { MAX_FILE_BYTES } from './docs';
import type { HubSpotItem, HubSpotRecord } from './types';

interface FileMeta {
  id: string;
  name?: string;
  extension?: string;
  size?: number;
  type?: string;
}

type Client = Pick<HubSpotClient, 'request' | 'download'>;

export async function signedUrl(client: Client, fileId: string): Promise<string> {
  const res = await client.request<{ url: string }>('GET', `/files/v3/files/${fileId}/signed-url`);
  return res.url;
}

/** `hs_attachment_ids` is a semicolon-separated id list on emails, notes and
 *  meetings. One broken file must not sink the engagement — warn and skip. */
export async function fetchAttachmentItems(
  client: Client,
  session: Session,
  record: HubSpotRecord,
  parentDocType: string,
): Promise<HubSpotItem[]> {
  const ids = (record.properties.hs_attachment_ids ?? '').split(';').map((s) => s.trim()).filter(Boolean);
  const out: HubSpotItem[] = [];
  for (const fileId of ids) {
    if (session.signal.aborted) break;
    try {
      const meta = await client.request<FileMeta>('GET', `/files/v3/files/${fileId}`);
      const filename = meta.extension ? `${meta.name ?? fileId}.${meta.extension}` : (meta.name ?? fileId);
      const size = meta.size ?? 0;
      let bytes: Uint8Array | null = null;
      let mime = 'application/octet-stream';
      if (size <= MAX_FILE_BYTES) {
        const dl = await client.download(await signedUrl(client, fileId));
        bytes = dl.bytes;
        mime = dl.mime;
      }
      out.push({
        kind: 'file',
        fileId,
        filename,
        mime,
        size,
        bytes,
        parent: { externalId: record.id, type: parentDocType },
        createdAt: record.properties.hs_timestamp ?? null,
      });
    } catch (e) {
      session.log('warn', `hubspot attachment ${fileId} skipped: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return out;
}
```

- [ ] **Step 4: Run tests**

Run: `npx jest src/__tests__/attachments.test.ts` — Expected: PASS. `npm run typecheck` — PASS.

- [ ] **Step 5: Commit**

```bash
git add src/attachments.ts src/__tests__/attachments.test.ts
git commit -m "feat: engagement attachment fetching via Files API"
```

---

### Task 8: Backfill

**Files:**
- Create: `src/backfill.ts`
- Test: `src/__tests__/backfill.test.ts`

**Interfaces:**
- Consumes: `HubSpotClient`, `fetchAttachmentItems` (Task 7), `propsFor` (Task 4), types.
- Produces: `backfill(client, session, cursor: HubSpotCursor | null, ctx: RenderContext): AsyncGenerator<Batch<HubSpotCursor, HubSpotItem>>`, `assocFromRecord(record): Associations` (exported; reused by delta tests).

- [ ] **Step 1: Write the failing test** — `src/__tests__/backfill.test.ts`

```ts
import { assocFromRecord, backfill } from '../backfill';
import type { Batch, Session } from '../kiagent-contracts';
import type { HubSpotCursor, HubSpotItem, RenderContext } from '../types';
import { ALL_TYPES } from '../types';

const ctx: RenderContext = { portalId: '1', owners: {}, dealStages: {}, ticketStages: {}, customProps: {} };

const mkSession = () => {
  const ac = new AbortController();
  return {
    session: { signal: ac.signal, log: jest.fn(), credentials: async () => ({ password: 'pat-x' }) } as unknown as Session,
    ac,
  };
};

/** Every type returns one single-record page except contacts (two pages). */
function stubClient() {
  const paths: string[] = [];
  const client = {
    requestCount: 0,
    paths,
    request: async <T>(_m: string, pathname: string): Promise<T> => {
      paths.push(pathname);
      const type = pathname.split('?')[0].split('/')[4];
      if (type === 'contacts' && !pathname.includes('after=')) {
        return { results: [{ id: 'c1', properties: {}, associations: { companies: { results: [{ id: '77', type: 'x' }] } } }], paging: { next: { after: 'P2' } } } as T;
      }
      if (type === 'contacts') return { results: [{ id: 'c2', properties: {} }] } as T;
      return { results: [{ id: `${type}-1`, properties: {} }] } as T;
    },
    download: async () => ({ bytes: new Uint8Array(), mime: 'x' }),
  };
  return client;
}

async function drain(gen: AsyncIterable<Batch<HubSpotCursor, HubSpotItem>>) {
  const batches: Batch<HubSpotCursor, HubSpotItem>[] = [];
  for await (const b of gen) batches.push(b);
  return batches;
}

describe('backfill', () => {
  it('walks all types in order, pages within a type, ends live', async () => {
    const { session } = mkSession();
    const batches = await drain(backfill(stubClient() as never, session, null, ctx));

    // 9 types, contacts contributes 2 pages → 10 backfill batches + 1 final live
    expect(batches).toHaveLength(11);
    expect(batches[0].phase).toBe('backfill');
    expect((batches[0].items[0] as { record: { id: string } }).record.id).toBe('companies-1');

    // contacts page 1 carries its paging cursor
    const contactsPage1 = batches[1];
    expect(contactsPage1.cursor).toMatchObject({ phase: 'backfill', step: 'contacts', after: 'P2' });
    // association came through from the list endpoint
    expect((contactsPage1.items[0] as { assoc: unknown }).assoc).toEqual({ companies: ['77'] });

    const last = batches[batches.length - 1];
    expect(last.phase).toBe('live');
    expect(last.items).toHaveLength(0);
    const lastCursor = last.cursor as Extract<HubSpotCursor, { phase: 'live' }>;
    for (const t of ALL_TYPES) expect(typeof lastCursor.watermarks[t]).toBe('string');
  });

  it('resumes mid-type from a backfill cursor', async () => {
    const { session } = mkSession();
    const client = stubClient();
    const cursor: HubSpotCursor = {
      phase: 'backfill',
      step: 'contacts',
      after: 'P2',
      watermarks: { companies: '2026-01-01T00:00:00.000Z' },
      backfillStartedAt: '2026-01-01T00:00:00.000Z',
    };
    const batches = await drain(backfill(client as never, session, cursor, ctx));
    // contacts page 2, then the 7 remaining types, then live
    expect(client.paths[0]).toContain('after=P2');
    expect(batches[batches.length - 1].phase).toBe('live');
    const wm = (batches[batches.length - 1].cursor as Extract<HubSpotCursor, { phase: 'live' }>).watermarks;
    expect(wm.companies).toBe('2026-01-01T00:00:00.000Z'); // preserved, not restamped
  });

  it('stops yielding on abort', async () => {
    const { session, ac } = mkSession();
    const gen = backfill(stubClient() as never, session, null, ctx);
    const first = await gen[Symbol.asyncIterator]().next();
    expect(first.done).toBe(false);
    ac.abort();
    const rest = await drain(gen as AsyncIterable<Batch<HubSpotCursor, HubSpotItem>>);
    expect(rest).toHaveLength(0);
  });

  it('requests attachments for engagement records that have them', async () => {
    const { session } = mkSession();
    const client = stubClient();
    // make notes return an attachment id and serve the files endpoints
    const base = client.request.bind(client);
    client.request = (async <T>(m: 'GET' | 'POST', pathname: string): Promise<T> => {
      if (pathname.startsWith('/crm/v3/objects/notes')) {
        return { results: [{ id: 'n1', properties: { hs_attachment_ids: 'f1' } }] } as T;
      }
      if (pathname === '/files/v3/files/f1') return { id: 'f1', name: 'a', extension: 'txt', size: 3 } as T;
      if (pathname === '/files/v3/files/f1/signed-url') return { url: 'https://s/f1' } as T;
      return base(m, pathname) as Promise<T>;
    }) as typeof client.request;
    client.download = async () => ({ bytes: new Uint8Array([1]), mime: 'text/plain' });

    const batches = await drain(backfill(client as never, session, null, ctx));
    const noteBatch = batches.find((b) => b.items.some((i) => (i as { kind: string }).kind === 'notes'))!;
    const kinds = noteBatch.items.map((i) => (i as { kind: string }).kind);
    expect(kinds).toEqual(['notes', 'file']); // file doc rides the SAME batch as its parent
  });
});

describe('assocFromRecord', () => {
  it('extracts and dedupes association ids per type', () => {
    expect(
      assocFromRecord({
        id: '1',
        properties: {},
        associations: {
          companies: { results: [{ id: '7', type: 'a' }, { id: '7', type: 'b' }] },
          deals: { results: [{ id: '8', type: 'c' }] },
        },
      }),
    ).toEqual({ companies: ['7'], deals: ['8'] });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx jest src/__tests__/backfill.test.ts` — Expected: FAIL, module not found.

- [ ] **Step 3: Write `src/backfill.ts`**

```ts
import { fetchAttachmentItems } from './attachments';
import type { HubSpotClient } from './client';
import type { Batch, Session } from './kiagent-contracts';
import { propsFor } from './properties';
import {
  ALL_TYPES,
  DOC_TYPE,
  ENGAGEMENT_TYPES,
  OBJECT_TYPES,
  type Associations,
  type HubSpotCursor,
  type HubSpotItem,
  type HubSpotRecord,
  type ListEnvelope,
  type RenderContext,
  type TypeKey,
} from './types';

const PAGE_LIMIT = 100;

export function assocFromRecord(record: HubSpotRecord): Associations {
  const out: Associations = {};
  for (const t of OBJECT_TYPES) {
    const ids = record.associations?.[t]?.results?.map((r) => r.id) ?? [];
    if (ids.length) out[t] = [...new Set(ids)];
  }
  return out;
}

const isEngagement = (t: TypeKey): boolean => (ENGAGEMENT_TYPES as readonly string[]).includes(t);

function listPath(type: TypeKey, after: string | null, props: string[]): string {
  const params = new URLSearchParams({
    limit: String(PAGE_LIMIT),
    archived: 'false',
    properties: props.join(','),
    associations: OBJECT_TYPES.join(','),
  });
  if (after) params.set('after', after);
  return `/crm/v3/objects/${type}?${params.toString()}`;
}

/**
 * Phased, resumable backfill: every type in ALL_TYPES order (objects before
 * engagements so engagement parent refs resolve against already-committed
 * docs), one Batch per page — each yield is a crash-safe checkpoint. Finishes
 * with an empty `live` batch so delta never sees a backfill cursor. Watermarks
 * are stamped with backfillStartedAt (delta's overlap re-covers anything
 * modified mid-backfill).
 */
export async function* backfill(
  client: HubSpotClient,
  session: Session,
  cursor: Extract<HubSpotCursor, { phase: 'backfill' }> | null,
  ctx: RenderContext,
): AsyncGenerator<Batch<HubSpotCursor, HubSpotItem>> {
  const watermarks = { ...(cursor?.watermarks ?? {}) };
  const startedAt = cursor?.backfillStartedAt ?? new Date().toISOString();
  let stepIdx = Math.max(0, ALL_TYPES.indexOf(cursor?.step ?? 'companies'));
  let after: string | null = cursor?.after ?? null;

  for (; stepIdx < ALL_TYPES.length; stepIdx++) {
    const step = ALL_TYPES[stepIdx];
    for (;;) {
      if (session.signal.aborted) return;
      const page = await client.request<ListEnvelope>('GET', listPath(step, after, propsFor(step, ctx)));

      const items: HubSpotItem[] = [];
      for (const record of page.results ?? []) {
        if (session.signal.aborted) return;
        const assoc = assocFromRecord(record);
        items.push({ kind: step, record, assoc, ctx });
        if (isEngagement(step) && record.properties.hs_attachment_ids) {
          items.push(...(await fetchAttachmentItems(client, session, record, DOC_TYPE[step])));
        }
      }

      after = page.paging?.next?.after ?? null;
      if (!after) watermarks[step] = startedAt;
      const next: HubSpotCursor = after
        ? { phase: 'backfill', step, after, watermarks: { ...watermarks }, backfillStartedAt: startedAt }
        : {
            phase: 'backfill',
            step: ALL_TYPES[stepIdx + 1] ?? step,
            after: null,
            watermarks: { ...watermarks },
            backfillStartedAt: startedAt,
          };
      yield { phase: 'backfill', items, cursor: structuredClone(next) };
      if (!after) break;
    }
  }

  const full = Object.fromEntries(ALL_TYPES.map((t) => [t, watermarks[t] ?? startedAt])) as Record<TypeKey, string>;
  yield { phase: 'live', items: [], cursor: { phase: 'live', watermarks: full } };
}
```

- [ ] **Step 4: Run tests**

Run: `npx jest src/__tests__/backfill.test.ts` — Expected: PASS. `npm run typecheck` — PASS.

- [ ] **Step 5: Commit**

```bash
git add src/backfill.ts src/__tests__/backfill.test.ts
git commit -m "feat: phased resumable backfill over all CRM and engagement types"
```

---

### Task 9: Delta sync

**Files:**
- Create: `src/delta.ts`
- Test: `src/__tests__/delta.test.ts`

**Interfaces:**
- Consumes: `HubSpotClient`, `assocFromRecord` NOT reused here (search returns no associations — uses `batchReadAssociations` instead), `fetchAttachmentItems` (Task 7), `propsFor` (Task 4), `LAST_MODIFIED_PROP`, types.
- Produces: `delta(client, session, cursor: Extract<HubSpotCursor, {phase:'live'}>, ctx): AsyncGenerator<Batch<HubSpotCursor, HubSpotItem>>` (includes the archived sweep — Task 10 extends this file), `DELTA_REQUEST_BUDGET = 60`, `OVERLAP_MS = 300_000`, `batchReadAssociations(client, fromType, ids): Promise<Record<string, Associations>>`.

- [ ] **Step 1: Write the failing test** — `src/__tests__/delta.test.ts`

```ts
import { batchReadAssociations, delta, DELTA_REQUEST_BUDGET, OVERLAP_MS } from '../delta';
import type { Batch, Session } from '../kiagent-contracts';
import { ALL_TYPES, type HubSpotCursor, type HubSpotItem, type RenderContext, type TypeKey } from '../types';

const ctx: RenderContext = { portalId: '1', owners: {}, dealStages: {}, ticketStages: {}, customProps: {} };

const session = {
  signal: new AbortController().signal,
  log: jest.fn(),
} as unknown as Session;

const liveCursor = (over: Partial<Record<TypeKey, string>> = {}): Extract<HubSpotCursor, { phase: 'live' }> => ({
  phase: 'live',
  watermarks: Object.fromEntries(ALL_TYPES.map((t) => [t, over[t] ?? '2026-07-01T00:00:00.000Z'])) as Record<TypeKey, string>,
});

async function drain(gen: AsyncIterable<Batch<HubSpotCursor, HubSpotItem>>) {
  const out: Batch<HubSpotCursor, HubSpotItem>[] = [];
  for await (const b of gen) out.push(b);
  return out;
}

/** requestCount is what the budget reads — the stub must bump it like the real client. */
function stubClient(handler: (m: string, pathname: string, body?: unknown) => unknown) {
  const client = {
    requestCount: 0,
    calls: [] as Array<{ pathname: string; body?: unknown }>,
    request: async <T>(m: 'GET' | 'POST', pathname: string, body?: unknown): Promise<T> => {
      client.requestCount += 1;
      client.calls.push({ pathname, body });
      return handler(m, pathname, body) as T;
    },
    download: async () => ({ bytes: new Uint8Array(), mime: 'x' }),
  };
  return client;
}

const emptySearch = { results: [], total: 0 };
const emptyList = { results: [] };

describe('delta', () => {
  it('searches each type with GTE watermark-overlap and advances watermarks past emitted records', async () => {
    const client = stubClient((_m, pathname, body) => {
      if (pathname === '/crm/v3/objects/contacts/search') {
        const b = body as { filterGroups: Array<{ filters: Array<{ propertyName: string; operator: string; value: string }> }> };
        expect(b.filterGroups[0].filters[0]).toEqual({
          propertyName: 'lastmodifieddate',
          operator: 'GTE',
          value: String(Date.parse('2026-07-01T00:00:00.000Z') - OVERLAP_MS),
        });
        return { results: [{ id: 'c9', properties: { lastmodifieddate: '2026-07-01T05:00:00.000Z' } }], total: 1 };
      }
      if (pathname.endsWith('/search')) return emptySearch;
      if (pathname === '/crm/v4/associations/contacts/companies/batch/read')
        return { results: [{ from: { id: 'c9' }, to: [{ toObjectId: 77 }] }] };
      if (pathname.includes('/associations/')) return { results: [] };
      return emptyList; // archived sweep pages
    });

    const batches = await drain(delta(client as never, session, liveCursor(), ctx));
    const withItems = batches.filter((b) => b.items.length > 0);
    expect(withItems).toHaveLength(1);
    const item = withItems[0].items[0] as Extract<HubSpotItem, { kind: TypeKey }>;
    expect(item.kind).toBe('contacts');
    expect(item.record.id).toBe('c9');
    expect(item.assoc).toEqual({ companies: ['77'] }); // only the contacts→companies read returns rows
    const cur = withItems[0].cursor as Extract<HubSpotCursor, { phase: 'live' }>;
    expect(cur.watermarks.contacts).toBe('2026-07-01T05:00:00.000Z');
  });

  it('visits stalest type first', async () => {
    const client = stubClient((_m, pathname) => (pathname.endsWith('/search') ? emptySearch : emptyList));
    await drain(delta(client as never, session, liveCursor({ tasks: '2026-01-01T00:00:00.000Z' }), ctx));
    const searches = client.calls.filter((c) => c.pathname.endsWith('/search'));
    expect(searches[0].pathname).toBe('/crm/v3/objects/tasks/search');
  });

  it('stops issuing new searches once the budget is exhausted', async () => {
    const client = stubClient((_m, pathname) =>
      pathname.endsWith('/search')
        ? {
            results: Array.from({ length: 100 }, (_, i) => ({ id: `x${i}`, properties: { hs_lastmodifieddate: '2026-07-02T00:00:00.000Z' } })),
            paging: { next: { after: '100' } },
            total: 20000,
          }
        : { results: [] },
    );
    await drain(delta(client as never, session, liveCursor(), ctx));
    expect(client.requestCount).toBeLessThanOrEqual(DELTA_REQUEST_BUDGET + 5); // in-flight page + assoc reads may finish
  });

  it('re-windows instead of paging past the 10k search cap', async () => {
    let searchCalls = 0;
    const client = stubClient((_m, pathname, body) => {
      if (pathname === '/crm/v3/objects/contacts/search') {
        searchCalls += 1;
        if (searchCalls === 1) {
          expect((body as { after?: string }).after).toBeUndefined();
          return {
            results: [{ id: 'a', properties: { lastmodifieddate: '2026-07-03T00:00:00.000Z' } }],
            paging: { next: { after: '9900' } },
            total: 15000,
          };
        }
        // re-issued WINDOW query, not a page-after query
        expect((body as { after?: string }).after).toBeUndefined();
        const f = (body as { filterGroups: Array<{ filters: Array<{ value: string }> }> }).filterGroups[0].filters[0];
        expect(f.value).toBe(String(Date.parse('2026-07-03T00:00:00.000Z')));
        return emptySearch;
      }
      if (pathname.endsWith('/search')) return emptySearch;
      if (pathname.includes('/associations/')) return { results: [] };
      return emptyList;
    });
    await drain(delta(client as never, session, liveCursor(), ctx));
    expect(searchCalls).toBe(2);
  });
});

describe('batchReadAssociations', () => {
  it('reads all four object types and merges per-record', async () => {
    const client = stubClient((_m, pathname, body) => {
      expect(body).toEqual({ inputs: [{ id: 'n1' }] });
      if (pathname === '/crm/v4/associations/notes/contacts/batch/read')
        return { results: [{ from: { id: 'n1' }, to: [{ toObjectId: 501 }] }] };
      return { results: [] };
    });
    const map = await batchReadAssociations(client as never, 'notes', ['n1']);
    expect(map['n1']).toEqual({ contacts: ['501'] });
    expect(client.requestCount).toBe(4); // one per object type
  });

  it('short-circuits on empty input', async () => {
    const client = stubClient(() => ({ results: [] }));
    expect(await batchReadAssociations(client as never, 'notes', [])).toEqual({});
    expect(client.requestCount).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx jest src/__tests__/delta.test.ts` — Expected: FAIL, module not found.

- [ ] **Step 3: Write `src/delta.ts`** (the `archivedSweep` generator referenced at the end is written in Task 10 — for THIS task stub it as `async function* archivedSweep() {}` with the real signature so the file compiles and the delta tests pass; the empty-list archived responses in the stubs above keep it inert once real)

```ts
import { fetchAttachmentItems } from './attachments';
import type { HubSpotClient } from './client';
import type { Batch, Session } from './kiagent-contracts';
import { propsFor } from './properties';
import {
  ALL_TYPES,
  DOC_TYPE,
  ENGAGEMENT_TYPES,
  LAST_MODIFIED_PROP,
  OBJECT_TYPES,
  type Associations,
  type HubSpotCursor,
  type HubSpotItem,
  type HubSpotRecord,
  type RenderContext,
  type SearchEnvelope,
  type TypeKey,
} from './types';

/** One 30-minute tick stays cheap: ~60 API calls, stalest types first;
 *  anything unfinished resumes next tick from its unadvanced watermark. */
export const DELTA_REQUEST_BUDGET = 60;
/** Search indexing lags writes; 5 minutes of overlap re-covers the boundary. */
export const OVERLAP_MS = 5 * 60_000;
/** HubSpot search refuses paging past 10k results — re-window before that. */
const SEARCH_PAGE_CAP = 9_900;
const PAGE_LIMIT = 100;

type LiveCursor = Extract<HubSpotCursor, { phase: 'live' }>;

export async function batchReadAssociations(
  client: HubSpotClient,
  fromType: TypeKey,
  ids: string[],
): Promise<Record<string, Associations>> {
  const out: Record<string, Associations> = {};
  if (ids.length === 0) return out;
  for (const to of OBJECT_TYPES) {
    if (to === fromType) continue;
    const res = await client.request<{
      results?: Array<{ from: { id: string }; to: Array<{ toObjectId: number | string }> }>;
    }>('POST', `/crm/v4/associations/${fromType}/${to}/batch/read`, {
      inputs: ids.map((id) => ({ id })),
    });
    for (const row of res.results ?? []) {
      const bucket = (out[row.from.id] ??= {});
      const list = row.to.map((t) => String(t.toObjectId));
      if (list.length) bucket[to] = [...new Set([...(bucket[to] ?? []), ...list])];
    }
  }
  return out;
}

const isEngagement = (t: TypeKey): boolean => (ENGAGEMENT_TYPES as readonly string[]).includes(t);

/**
 * Per-type ascending search on last-modified ≥ watermark − overlap. After each
 * page the type's watermark advances to the last emitted record's timestamp —
 * items and cursor commit in one transaction, so a crash re-does at most one
 * page. Hitting the 10k pager cap re-issues a fresh window from the advanced
 * watermark instead of paging on.
 */
export async function* delta(
  client: HubSpotClient,
  session: Session,
  cursor: LiveCursor,
  ctx: RenderContext,
): AsyncGenerator<Batch<HubSpotCursor, HubSpotItem>> {
  const watermarks = { ...cursor.watermarks };
  const budgetLeft = () => DELTA_REQUEST_BUDGET - client.requestCount;
  const order = [...ALL_TYPES].sort((a, b) => (watermarks[a] < watermarks[b] ? -1 : 1));

  for (const step of order) {
    if (session.signal.aborted) return;
    if (budgetLeft() <= 0) break;
    const prop = LAST_MODIFIED_PROP[step];
    let sinceMs = Date.parse(watermarks[step]) - OVERLAP_MS;
    let after: string | undefined;

    for (;;) {
      if (session.signal.aborted) return;
      if (budgetLeft() <= 0) break;

      const page = await client.request<SearchEnvelope>('POST', `/crm/v3/objects/${step}/search`, {
        filterGroups: [{ filters: [{ propertyName: prop, operator: 'GTE', value: String(sinceMs) }] }],
        sorts: [{ propertyName: prop, direction: 'ASCENDING' }],
        properties: propsFor(step, ctx),
        limit: PAGE_LIMIT,
        ...(after ? { after } : {}),
      });

      const records = page.results ?? [];
      if (records.length === 0) break;

      const assocMap = await batchReadAssociations(client, step, records.map((r) => r.id));
      const items: HubSpotItem[] = [];
      let maxSeen = watermarks[step];
      for (const record of records) {
        if (session.signal.aborted) return;
        items.push({ kind: step, record, assoc: assocMap[record.id] ?? {}, ctx });
        if (isEngagement(step) && record.properties.hs_attachment_ids) {
          items.push(...(await fetchAttachmentItems(client, session, record, DOC_TYPE[step])));
        }
        const lm = record.properties[prop];
        if (lm && lm > maxSeen) maxSeen = lm;
      }
      watermarks[step] = maxSeen;

      yield {
        phase: 'live',
        items,
        cursor: structuredClone({ phase: 'live', watermarks, archiveSweep: cursor.archiveSweep } as HubSpotCursor),
      };

      const nextAfter = page.paging?.next?.after;
      if (!nextAfter) break;
      if (Number(nextAfter) >= SEARCH_PAGE_CAP) {
        // Re-window: fresh search from the advanced watermark, no `after`.
        sinceMs = Date.parse(watermarks[step]);
        after = undefined;
      } else {
        after = nextAfter;
      }
    }
  }

  yield* archivedSweep(client, session, watermarks, cursor.archiveSweep, budgetLeft);
}

// Task 10 replaces this stub with the real archived-listing sweep.
// eslint-disable-next-line require-yield, @typescript-eslint/no-unused-vars
async function* archivedSweep(
  client: HubSpotClient,
  session: Session,
  watermarks: Record<TypeKey, string>,
  sweep: LiveCursor['archiveSweep'],
  budgetLeft: () => number,
): AsyncGenerator<Batch<HubSpotCursor, HubSpotItem>> {}
```

- [ ] **Step 4: Run tests**

Run: `npx jest src/__tests__/delta.test.ts` — Expected: PASS. `npm run typecheck` — PASS.

- [ ] **Step 5: Commit**

```bash
git add src/delta.ts src/__tests__/delta.test.ts
git commit -m "feat: budgeted search-based delta with watermark windowing"
```

---

### Task 10: Archived-listing sweep (deletions)

**Files:**
- Modify: `src/delta.ts` (replace the `archivedSweep` stub)
- Test: `src/__tests__/archived-sweep.test.ts`

**Interfaces:**
- Consumes: same file as Task 9.
- Produces: real `archivedSweep` — pages `GET /crm/v3/objects/{type}?archived=true` per type round-robin, emits `Batch.deletions` of `{externalId, type: DOC_TYPE[t]}` plus `{externalId: attachmentId, type: 'file'}` for archived engagements' `hs_attachment_ids`; persists resume position in `cursor.archiveSweep`; clears it after a full pass.

- [ ] **Step 1: Write the failing test** — `src/__tests__/archived-sweep.test.ts`

```ts
import { delta } from '../delta';
import type { Batch, Session } from '../kiagent-contracts';
import { ALL_TYPES, type HubSpotCursor, type HubSpotItem, type TypeKey, type RenderContext } from '../types';

const ctx: RenderContext = { portalId: '1', owners: {}, dealStages: {}, ticketStages: {}, customProps: {} };
const session = { signal: new AbortController().signal, log: jest.fn() } as unknown as Session;

const liveCursor = (archiveSweep?: { step: TypeKey; after: string | null }): Extract<HubSpotCursor, { phase: 'live' }> => ({
  phase: 'live',
  watermarks: Object.fromEntries(ALL_TYPES.map((t) => [t, '2026-07-01T00:00:00.000Z'])) as Record<TypeKey, string>,
  archiveSweep,
});

async function drain(gen: AsyncIterable<Batch<HubSpotCursor, HubSpotItem>>) {
  const out: Batch<HubSpotCursor, HubSpotItem>[] = [];
  for await (const b of gen) out.push(b);
  return out;
}

function stubClient(archivedByType: Partial<Record<TypeKey, unknown>>) {
  const client = {
    requestCount: 0,
    calls: [] as string[],
    request: async <T>(_m: string, pathname: string): Promise<T> => {
      client.requestCount += 1;
      client.calls.push(pathname);
      if (pathname.endsWith('/search')) return { results: [] } as T;
      if (pathname.includes('archived=true')) {
        const type = pathname.split('?')[0].split('/')[4] as TypeKey;
        return (archivedByType[type] ?? { results: [] }) as T;
      }
      return { results: [] } as T;
    },
    download: async () => ({ bytes: new Uint8Array(), mime: 'x' }),
  };
  return client;
}

describe('archivedSweep', () => {
  it('emits deletions for archived records, including engagement attachment file docs', async () => {
    const client = stubClient({
      contacts: { results: [{ id: 'c1', properties: {} }] },
      emails: { results: [{ id: 'e1', properties: { hs_attachment_ids: 'f1;f2' } }] },
    });
    const batches = await drain(delta(client as never, session, liveCursor(), ctx));
    const dels = batches.flatMap((b) => b.deletions ?? []);
    expect(dels).toContainEqual({ externalId: 'c1', type: 'hubspot.contact' });
    expect(dels).toContainEqual({ externalId: 'e1', type: 'hubspot.email' });
    expect(dels).toContainEqual({ externalId: 'f1', type: 'file' });
    expect(dels).toContainEqual({ externalId: 'f2', type: 'file' });
  });

  it('clears archiveSweep after a full pass', async () => {
    const client = stubClient({});
    const batches = await drain(delta(client as never, session, liveCursor(), ctx));
    const last = batches[batches.length - 1];
    expect((last.cursor as Extract<HubSpotCursor, { phase: 'live' }>).archiveSweep).toBeUndefined();
  });

  it('resumes from a stored sweep position and carries the pager cursor', async () => {
    // First tasks page carries a pager cursor; the resumed page is empty —
    // a stub that ALWAYS returns the pager would loop the sweep forever.
    let tasksCalls = 0;
    const client = stubClient({});
    const base = client.request.bind(client);
    client.request = (async <T>(m: 'GET' | 'POST', pathname: string): Promise<T> => {
      if (pathname.includes('/objects/tasks?') && pathname.includes('archived=true')) {
        client.requestCount += 1;
        client.calls.push(pathname);
        tasksCalls += 1;
        return (tasksCalls === 1
          ? { results: [{ id: 't1', properties: {} }], paging: { next: { after: 'T2' } } }
          : { results: [] }) as T;
      }
      return base(m, pathname) as Promise<T>;
    }) as typeof client.request;
    // start mid-rotation at tasks
    const batches = await drain(delta(client as never, session, liveCursor({ step: 'tasks', after: null }), ctx));
    const sweepCalls = client.calls.filter((c) => c.includes('archived=true'));
    expect(sweepCalls[0]).toContain('/crm/v3/objects/tasks?');
    // t1 deleted, then the pager cursor was carried into the batch cursor at least once
    const carried = batches.some((b) => {
      const c = b.cursor as Extract<HubSpotCursor, { phase: 'live' }>;
      return c.archiveSweep?.step === 'tasks' && c.archiveSweep.after === 'T2';
    });
    expect(carried).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx jest src/__tests__/archived-sweep.test.ts` — Expected: FAIL (stub yields nothing → no deletions found).

- [ ] **Step 3: Replace the `archivedSweep` stub in `src/delta.ts`**

```ts
/**
 * Deletion channel: HubSpot search excludes archived records, and a full
 * reconcile() listing of a large portal is thousands of requests per cycle —
 * so instead each tick pages the (small) archived=true listing per type,
 * emitting Batch.deletions. Round-robin position persists in
 * cursor.archiveSweep and clears after a full pass. Archived engagements also
 * delete their attachment file docs (ids still readable on the archived
 * record). GDPR hard-deletes never appear here — documented limitation.
 */
async function* archivedSweep(
  client: HubSpotClient,
  session: Session,
  watermarks: Record<TypeKey, string>,
  sweep: LiveCursor['archiveSweep'],
  budgetLeft: () => number,
): AsyncGenerator<Batch<HubSpotCursor, HubSpotItem>> {
  let idx = sweep ? Math.max(0, ALL_TYPES.indexOf(sweep.step)) : 0;
  let after: string | null = sweep?.after ?? null;

  for (; idx < ALL_TYPES.length; idx++) {
    const step = ALL_TYPES[idx];
    for (;;) {
      if (session.signal.aborted) return;
      if (budgetLeft() <= 0) {
        // Persist the resume point; nothing else changes this cursor.
        yield {
          phase: 'live',
          items: [],
          cursor: structuredClone({ phase: 'live', watermarks, archiveSweep: { step, after } } as HubSpotCursor),
        };
        return;
      }
      const params = new URLSearchParams({
        limit: '100',
        archived: 'true',
        properties: 'hs_attachment_ids',
      });
      if (after) params.set('after', after);
      const page = await client.request<SearchEnvelope>('GET', `/crm/v3/objects/${step}?${params.toString()}`);

      const deletions = (page.results ?? []).flatMap((r: HubSpotRecord) => {
        const refs = [{ externalId: r.id, type: DOC_TYPE[step] }];
        for (const fileId of (r.properties?.hs_attachment_ids ?? '').split(';').map((s) => s.trim()).filter(Boolean)) {
          refs.push({ externalId: fileId, type: 'file' });
        }
        return refs;
      });

      after = page.paging?.next?.after ?? null;
      const nextSweep = after
        ? { step, after }
        : idx + 1 < ALL_TYPES.length
          ? { step: ALL_TYPES[idx + 1], after: null }
          : undefined;

      if (deletions.length > 0 || nextSweep === undefined) {
        yield {
          phase: 'live',
          items: [],
          deletions,
          cursor: structuredClone({ phase: 'live', watermarks, ...(nextSweep ? { archiveSweep: nextSweep } : {}) } as HubSpotCursor),
        };
      }
      if (!after) break;
    }
  }
}
```

- [ ] **Step 4: Run ALL tests**

Run: `npx jest` — Expected: ALL PASS (delta tests from Task 9 must stay green — their stubs return empty archived listings). `npm run typecheck` — PASS.

- [ ] **Step 5: Commit**

```bash
git add src/delta.ts src/__tests__/archived-sweep.test.ts
git commit -m "feat: archived-listing sweep emitting deletions"
```

---

### Task 11: Source wiring — connect, pull dispatch, fetchBytes, entrypoint

**Files:**
- Create: `src/source.ts`, `src/index.ts`
- Test: `src/__tests__/source.test.ts`, `src/__tests__/bundle-load.test.ts`

**Interfaces:**
- Consumes: everything prior.
- Produces: `createHubSpotSource(host: HostFor<'net'>, clock?: Pick<HubSpotClientDeps, 'sleep' | 'now'>): Source<HubSpotCursor, HubSpotItem>`; default export `ExtensionModule<'net'>` in `index.ts`.

- [ ] **Step 1: Write the failing test** — `src/__tests__/source.test.ts`

```ts
import type { AuthChannel, Document, HostFor, Session } from '../kiagent-contracts';
import { createHubSpotSource } from '../source';

const enc = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));

function makeHost(routes: (url: string, init: any) => unknown): HostFor<'net'> {
  return {
    self: { id: 'hubspot', dataDir: '/tmp' },
    log: () => {},
    net: {
      fetch: async (url: string, init?: unknown) => {
        const hit = routes(url, init);
        if (hit instanceof Uint8Array) return { status: 200, statusText: '', headers: { 'content-type': 'application/pdf' }, body: hit };
        return { status: 200, statusText: '', headers: {}, body: enc(hit) };
      },
    },
  } as HostFor<'net'>;
}

const clock = { sleep: async () => {}, now: (() => { let t = 0; return () => (t += 1000); })() };

describe('descriptor', () => {
  it('declares the hubspot source', () => {
    const src = createHubSpotSource(makeHost(() => ({})), clock);
    expect(src.descriptor.id).toBe('hubspot');
    expect(src.descriptor.auth).toBe('password');
    expect(src.descriptor.multiAccount).toBe(true);
    expect(src.descriptor.cadence).toEqual({ every: '30m' });
    expect(src.descriptor.documentTypes).toContain('hubspot.contact');
    expect(src.descriptor.documentTypes).toContain('file');
  });
});

describe('connect', () => {
  const auth = (password: string): AuthChannel =>
    ({
      prompt: async (schema: unknown) => {
        // the wizard schema must carry x-steps and a password field
        const s = schema as { 'x-steps': unknown[]; properties: { password: unknown }; required: string[] };
        expect(Array.isArray(s['x-steps'])).toBe(true);
        expect(s.required).toContain('password');
        return { password };
      },
    }) as unknown as AuthChannel;

  it('validates token shape before calling the API', async () => {
    const src = createHubSpotSource(makeHost(() => { throw new Error('no call expected'); }), clock);
    await expect(src.connect(auth('xoxb-wrong'))).rejects.toThrow(/pat-/);
  });

  it('verifies against account-info and returns portal identifier + config', async () => {
    const src = createHubSpotSource(
      makeHost((url) => {
        expect(url).toBe('https://api.hubapi.com/account-info/v3/details');
        return { portalId: 4242, uiDomain: 'app.hubspot.com', accountType: 'STANDARD' };
      }),
      clock,
    );
    const res = await src.connect(auth('pat-na1-abc'));
    expect(res.identifier).toBe('portal-4242');
    expect(res.config).toEqual({ portalId: '4242' });
  });
});

describe('pull dispatch', () => {
  const session = (cursorlessOk = true) =>
    ({
      account: { config: { portalId: '1' } },
      signal: new AbortController().signal,
      credentials: async () => ({ password: cursorlessOk ? 'pat-x' : undefined }),
      log: () => {},
    }) as unknown as Session;

  it('throws without credentials', async () => {
    const src = createHubSpotSource(makeHost(() => ({ results: [] })), clock);
    const gen = src.pull(session(false), null);
    await expect(gen[Symbol.asyncIterator]().next()).rejects.toThrow(/credentials/);
  });

  it('null cursor → backfill batches then live', async () => {
    const src = createHubSpotSource(makeHost(() => ({ results: [] })), clock);
    const phases: string[] = [];
    for await (const b of src.pull(session(), null)) phases.push(b.phase);
    expect(phases[phases.length - 1]).toBe('live');
    expect(phases.filter((ph) => ph === 'backfill').length).toBeGreaterThan(0);
  });
});

describe('fetchBytes', () => {
  it('re-downloads a file doc via a fresh signed url', async () => {
    const src = createHubSpotSource(
      makeHost((url) => {
        if (url.endsWith('/files/v3/files/f1/signed-url')) return { url: 'https://signed.example/f1' };
        if (url === 'https://signed.example/f1') return new Uint8Array([9, 9]);
        return { results: [] };
      }),
      clock,
    );
    const doc = { type: 'file', metadata: { hubspot_file_id: 'f1' } } as unknown as Document;
    const bytes = await src.fetchBytes!(
      { credentials: async () => ({ password: 'pat-x' }), signal: new AbortController().signal, log: () => {}, account: { config: {} } } as unknown as Session,
      doc,
    );
    expect(Array.from(bytes!)).toEqual([9, 9]);
  });

  it('returns null for non-file docs', async () => {
    const src = createHubSpotSource(makeHost(() => ({})), clock);
    const doc = { type: 'hubspot.contact', metadata: {} } as unknown as Document;
    expect(
      await src.fetchBytes!({ credentials: async () => ({ password: 'pat-x' }), signal: new AbortController().signal, log: () => {}, account: { config: {} } } as unknown as Session, doc),
    ).toBe(null);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx jest src/__tests__/source.test.ts` — Expected: FAIL, `../source` not found.

- [ ] **Step 3: Write `src/source.ts`**

```ts
import { signedUrl } from './attachments';
import { backfill } from './backfill';
import { HubSpotClient, type HubSpotClientDeps, type NetFetch } from './client';
import { delta } from './delta';
import { renderItem } from './docs';
import type { AuthChannel, Document, HostFor, Session, Source } from './kiagent-contracts';
import { fetchRenderContext } from './lookups';
import { ALL_TYPES, DOC_TYPE, type HubSpotCursor, type HubSpotItem } from './types';

/** Read scopes the Private App needs — mirrored in README. account-info reads
 *  portal id at connect; sales-email-read unlocks email bodies; files unlocks
 *  attachment downloads. */
export const REQUIRED_SCOPES = [
  'crm.objects.contacts.read',
  'crm.objects.companies.read',
  'crm.objects.deals.read',
  'tickets',
  'crm.objects.owners.read',
  'sales-email-read',
  'files',
  'account-info.security.read',
];

async function requireToken(session: Session): Promise<string> {
  const creds = await session.credentials();
  const token = creds?.password;
  if (!token) throw new Error('no HubSpot credentials — reconnect the account');
  return token;
}

export function createHubSpotSource(
  host: HostFor<'net'>,
  // Test seam only: injectable sleep/now so tests never wait out the throttle.
  clock?: Pick<HubSpotClientDeps, 'sleep' | 'now'>,
): Source<HubSpotCursor, HubSpotItem> {
  const fetchFn = host.net.fetch as NetFetch;
  const makeClient = (token: string) => new HubSpotClient({ fetch: fetchFn, token, ...clock });

  return {
    descriptor: {
      id: 'hubspot',
      name: 'HubSpot',
      documentTypes: [...ALL_TYPES.map((t) => DOC_TYPE[t]), 'file'],
      auth: 'password',
      multiAccount: true,
      cadence: { every: '30m' },
    },

    async connect(auth: AuthChannel) {
      const answers = await auth.prompt({
        type: 'object',
        required: ['password'],
        description:
          'HubSpot indexing uses a Private App access token you create in your portal — read-only, no OAuth app involved.',
        'x-steps': [
          {
            title: 'Create a Private App',
            body: 'Settings → Integrations → Private Apps → Create private app. Name it e.g. "KIAgent".',
            link: 'https://app.hubspot.com/l/private-apps',
          },
          {
            title: 'Grant read scopes',
            body: `On the Scopes tab enable exactly these read scopes:\n${REQUIRED_SCOPES.join('\n')}`,
            copy: REQUIRED_SCOPES.join(' '),
          },
          {
            title: 'Copy the access token',
            body: 'Create the app, then Auth tab → Show token → Copy.',
          },
        ],
        properties: {
          password: {
            type: 'string',
            title: 'Private App access token',
            format: 'password',
            examples: ['pat-na1-…'],
            description: 'Starts with pat-.',
          },
        },
      });
      const token = typeof answers.password === 'string' ? answers.password.trim() : '';
      if (!/^pat-/.test(token)) {
        throw new Error('that does not look like a HubSpot Private App token (pat-…)');
      }
      const client = makeClient(token);
      const info = await client.request<{ portalId?: number; uiDomain?: string }>(
        'GET',
        '/account-info/v3/details',
      );
      const portalId = String(info.portalId ?? '');
      if (!portalId) throw new Error('could not read the portal id — is the account-info.security.read scope granted?');
      return { identifier: `portal-${portalId}`, config: { portalId } };
    },

    async *pull(session: Session, cursor: HubSpotCursor | null) {
      const token = await requireToken(session);
      const client = makeClient(token);
      const portalId = String(session.account.config.portalId ?? '');
      const ctx = await fetchRenderContext(client, portalId);
      if (cursor === null || cursor.phase === 'backfill') {
        yield* backfill(client, session, cursor, ctx);
      } else {
        yield* delta(client, session, cursor, ctx);
      }
    },

    toDocument(item: HubSpotItem) {
      return renderItem(item);
    },

    async fetchBytes(session: Session, doc: Document) {
      if (doc.type !== 'file') return null;
      const fileId = doc.metadata.hubspot_file_id;
      if (typeof fileId !== 'string' || !fileId) return null;
      const client = makeClient(await requireToken(session));
      const { bytes } = await client.download(await signedUrl(client, fileId));
      return bytes;
    },
  };
}
```

- [ ] **Step 4: Write `src/index.ts`**

```ts
import type { ExtensionModule } from './kiagent-contracts';
import { createHubSpotSource } from './source';

const mod = {
  async activate(host) {
    return { sources: [createHubSpotSource(host)] };
  },
} satisfies ExtensionModule<'net'>;

export default mod;
module.exports = mod;
```

- [ ] **Step 5: Write the bundle smoke test** — `src/__tests__/bundle-load.test.ts`

```ts
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import type { HostFor } from '../kiagent-contracts';

describe('dist bundle loads standalone', () => {
  it('require()s dist/index.js and activate() returns the hubspot source', async () => {
    const root = join(__dirname, '..', '..');
    execSync('npm run build', { cwd: root });
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require(join(root, 'dist', 'index.js'));
    const entry = mod.default ?? mod;
    expect(typeof entry.activate).toBe('function');

    const host: HostFor<'net'> = {
      self: { id: 'hubspot', dataDir: '/tmp' },
      log: () => {},
      net: {
        fetch: async () => {
          throw new Error('unused in this smoke test');
        },
      },
    };
    const result = await entry.activate(host);

    expect(result.sources).toHaveLength(1);
    expect(result.sources?.[0]?.descriptor.id).toBe('hubspot');
  }, 30_000);
});
```

- [ ] **Step 6: Run the full suite**

Run: `npx jest` — Expected: ALL PASS. `npm run typecheck` — PASS.

- [ ] **Step 7: Commit**

```bash
git add src/source.ts src/index.ts src/__tests__/source.test.ts src/__tests__/bundle-load.test.ts
git commit -m "feat: source wiring — connect, pull dispatch, fetchBytes, entrypoint"
```

---

### Task 12: README, packaging, final verification

**Files:**
- Create: `README.md`

**Interfaces:**
- Consumes: `REQUIRED_SCOPES` (Task 11) — keep the README scope list identical.

- [ ] **Step 1: Write `README.md`** (established section order; adjust wording only if a claim is untrue)

```markdown
# HubSpot connector for KIAgent

Indexes a HubSpot portal into local KIAgent memory — contacts, companies,
deals and tickets as structured records, plus the full engagement timeline
(emails, notes, calls, meetings, tasks) and engagement attachments, kept in
sync incrementally via a read-only Private App token.

## Install

Install from the KIAgent marketplace (Extensions → HubSpot). The extension
requests the `net` capability — it talks only to `api.hubapi.com` and
HubSpot's signed file-download URLs.

## Connect your portal

1. In HubSpot: **Settings → Integrations → Private Apps → Create private app**.
   Name it e.g. `KIAgent`.
2. On the **Scopes** tab enable exactly these read scopes:
   `crm.objects.contacts.read` `crm.objects.companies.read`
   `crm.objects.deals.read` `tickets` `crm.objects.owners.read`
   `sales-email-read` `files` `account-info.security.read`
3. Create the app, open the **Auth** tab, copy the access token (`pat-…`)
   and paste it into the KIAgent connect wizard.

One KIAgent account per portal; connect again for additional portals.

## What gets indexed

- One document per **contact, company, deal, ticket** — key properties plus
  all custom properties, with owner names and pipeline/stage labels resolved.
- One document per **email, note, call, meeting, task**, attached to its most
  relevant record (contact > deal > ticket > company); all other
  associations kept as metadata.
- **Attachments** on emails, notes and meetings (≤50 MB) — extracted and
  OCR'd by the KIAgent platform.

## Sync behavior

- **Backfill:** pages every record type oldest-first (objects before
  engagements) with crash-safe checkpoints after every page.
- **Live sync:** every **30 minutes**, modified records are picked up via the
  CRM search API with per-type watermarks; each tick is capped at a small
  request budget, stalest types first.
- **Deletions:** each tick also sweeps HubSpot's archived-record listing and
  archives those documents (and their attachment documents) in KIAgent.
  GDPR hard-deletes leave no archived record and are not detected.

## Privacy

This extension has no server of its own and no analytics. Your token is
stored in KIAgent's encrypted credential vault; data flows only from
HubSpot's API into your local KIAgent memory — nothing is sent anywhere else.

## Build from source

```bash
npm install
npm test
npm run typecheck
npm run build
npm pack
```

The `.tgz` produced by `npm pack` is the installable extension artifact.

## License

MIT
```

- [ ] **Step 2: Full verification**

```bash
npm test && npm run typecheck && npm run build && npm pack
tar -tzf hubspot-kia-connector-0.1.0.tgz
```

Expected: all green; the tarball lists `package/manifest.json`, `package/dist/index.js`, `package/README.md`, `package/icon.png`.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: README with install, scopes, sync behavior"
```

- [ ] **Step 4: Requesting code review**

Use the superpowers:requesting-code-review flow on the whole branch before finishing; then the superpowers:finishing-a-development-branch skill (ask Eldar how to land: this is a NEW repo destined for github.com/kia-plugins/hubspot-kia-connector with topic `kia-plugin`).

---

## Verification checklist (whole plan)

- [ ] `npm test` green (client, render, lookups, docs ×2, attachments, backfill, delta, archived-sweep, source, bundle-load)
- [ ] `npm run typecheck` green
- [ ] `npm run build && npm pack` produces a tarball containing manifest, dist, README, icon
- [ ] `manifest.json` and `package.json` versions match (0.1.0)
- [ ] No runtime dependencies in `package.json`
- [ ] `src/kiagent-contracts.ts` untouched after vendoring
```
