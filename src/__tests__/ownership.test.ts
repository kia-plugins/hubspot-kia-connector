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
