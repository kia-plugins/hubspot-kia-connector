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
