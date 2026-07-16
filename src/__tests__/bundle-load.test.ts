import { execSync } from 'node:child_process';
import { join } from 'node:path';
import type { HostFor } from '../kiagent-contracts';

describe('dist bundle loads standalone', () => {
  it('require()s dist/index.js and activate() returns the hubspot source', async () => {
    const root = join(__dirname, '..', '..');
    execSync('npm run build', { cwd: root });
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require(join(root, 'dist', 'index.js'));
    const entry = mod.default ?? mod;
    expect(typeof entry.activate).toBe('function');

    const host: HostFor<'net'> = {
      self: { id: 'hubspot', dataDir: '/tmp' },
      log: () => {},
      net: {
        fetch: async () => {
          throw new Error('unused in this smoke test');
        },
      },
    };
    const result = await entry.activate(host);

    expect(result.sources).toHaveLength(1);
    expect(result.sources?.[0]?.descriptor.id).toBe('hubspot');
  }, 30_000);
});
