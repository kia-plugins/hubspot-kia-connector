import type { ExtensionModule } from './kiagent-contracts';
import { createHubSpotSource } from './source';

const mod = {
  async activate(host) {
    return { sources: [createHubSpotSource(host)] };
  },
} satisfies ExtensionModule<'net'>;

export default mod;
module.exports = mod;
