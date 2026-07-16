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
