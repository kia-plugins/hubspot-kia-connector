import type { HubSpotClient } from './client';
import type { Session } from '@kiagent/connector-sdk';
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
