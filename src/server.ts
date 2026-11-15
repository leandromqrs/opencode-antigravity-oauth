import { Plugin } from '@opencode/plugin';
import { createAntigravityPlugin } from './configured-plugin.js';

export default Plugin.define({
  id: 'opencode-antigravity-oauth',
  async setup(ctx) {
    return createAntigravityPlugin(ctx.options, { fetch: (url, init) => globalThis.fetch(url, init) }).setup(ctx);
  },
});
