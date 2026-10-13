/** Copied from alpha-cent extensions/people/src/rules/public-domains.ts
 *  (origin/dev) — webmail domains never name an organisation. */
export const PUBLIC_DOMAINS: ReadonlySet<string> = new Set([
  'gmail.com',
  'googlemail.com',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'yahoo.com',
  'yahoo.de',
  'icloud.com',
  'me.com',
  'gmx.de',
  'gmx.net',
  'web.de',
  't-online.de',
  'proton.me',
  'protonmail.com',
  'posteo.de',
  'mail.de',
  'aol.com',
  'ukr.net',
  'i.ua',
  'meta.ua',
  // 2026-10-10: free mail seen in real mailboxes (DE/RU/UA/PL/US); without
  // them a mail.ru friend became "the company mail.ru" and Work by rule.
  'hotmail.de',
  'outlook.de',
  'live.de',
  'msn.com',
  'mac.com',
  'gmx.com',
  'gmx-topmail.de',
  'freenet.de',
  'arcor.de',
  'alice.de',
  'mail.ru',
  'list.ru',
  'inbox.ru',
  'bk.ru',
  'yandex.ru',
  'yandex.ua',
  'ya.ru',
  'rambler.ru',
  'bigmir.net',
  'ua.fm',
  'op.pl',
  'wp.pl',
  'o2.pl',
  'interia.pl',
  'excite.com',
  'verizon.net',
  'att.net',
  'comcast.net',
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
