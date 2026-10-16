import { registerHooks } from 'node:module';

const SDK_CONFIG_SUFFIX = '/@earendil-works/pi-coding-agent/dist/config.js';
const DEFAULT_CONFIG_EXPRESSION = 'pkg.piConfig?.configDir || ".pi"';
const WORKAGENT_CONFIG_EXPRESSION = '".workagent"';
const registrationKey = Symbol.for('@workagent/pi-sdk-config-hook');

// Pi's public configDir option comes from its own package.json. Keep that package
// file and getPackageDir intact: both are also used to locate SDK assets.
if (!globalThis[registrationKey]) {
  registerHooks({
    load(url, context, nextLoad) {
      const loaded = nextLoad(url, context);
      if (loaded.format !== 'module' || !url.replaceAll('\\', '/').endsWith(SDK_CONFIG_SUFFIX)) return loaded;

      const source = typeof loaded.source === 'string'
        ? loaded.source
        : Buffer.from(loaded.source ?? '').toString('utf8');
      if (!source.includes(DEFAULT_CONFIG_EXPRESSION)) {
        throw new Error(`Unsupported Pi SDK config contract in ${url}`);
      }
      return {
        ...loaded,
        source: source.replace(DEFAULT_CONFIG_EXPRESSION, WORKAGENT_CONFIG_EXPRESSION),
      };
    },
  });
  globalThis[registrationKey] = true;
}
