import { signedUrl } from './attachments';
import { backfill } from './backfill';
import { HubSpotClient, type HubSpotClientDeps, type NetFetch } from './client';
import { delta } from './delta';
import { renderItem } from './docs';
import type { AuthChannel, Document, HostFor, Session, Source } from '@kiagent/connector-sdk';
import { SourceAuthError, SourcePermanentError } from '@kiagent/connector-sdk';
import { DOSSIER_DOC_TYPE } from './dossier/layout';
import { dossierPass, isPassDue } from './dossier/pass';
import { fetchRenderContext } from './lookups';
import { CURSOR_VERSION, DOC_TYPE, INCREMENTAL_TYPES, type HubSpotCursor, type HubSpotItem } from './types';

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

export const UPGRADE_MESSAGE = 'Remove and re-add the HubSpot account to upgrade to dossiers';

async function requireToken(session: Session): Promise<string> {
  const creds = await session.credentials();
  const token = creds?.password;
  if (!token) throw new SourceAuthError('no HubSpot credentials — reconnect the account');
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
      documentTypes: [...INCREMENTAL_TYPES.map((t) => DOC_TYPE[t]), DOSSIER_DOC_TYPE, 'file'],
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
