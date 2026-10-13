import type { HubSpotRecord } from './types';

/** Spec §1: outbound (`EMAIL`) sends without attachments belong to the
 *  dossier pass; incoming/forwarded replies and attached sends stay
 *  standalone on the incremental path (their file docs parent on them). */
export function isPassOwnedEmail(record: HubSpotRecord): boolean {
  const p = record.properties ?? {};
  return p.hs_email_direction === 'EMAIL' && !(p.hs_attachment_ids ?? '').trim();
}
