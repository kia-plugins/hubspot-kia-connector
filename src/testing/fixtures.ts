import type { RenderContext } from '../types';

export const ctx: RenderContext = {
  portalId: '123',
  owners: { '9': { name: 'Ada Lovelace', email: 'ada@x.co' } },
  dealStages: { s2: { pipeline: 'Sales', stage: 'Won' } },
  ticketStages: { t1: { pipeline: 'Support', stage: 'New' } },
  customProps: { contacts: { favorite_color: 'Favorite color' } },
};
