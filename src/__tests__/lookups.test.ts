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
