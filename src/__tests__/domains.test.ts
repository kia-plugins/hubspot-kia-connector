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
