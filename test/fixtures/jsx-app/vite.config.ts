import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Probes stage a copy of this fixture outside the repo, so the plugin and the
// index location are passed in rather than resolved relative to this file.
const pluginEntry =
  process.env.KILN_PROVENANCE_PLUGIN ??
  new URL('../../../src/provenance/plugin.ts', import.meta.url).pathname;

const { provenancePlugin } = await import(pluginEntry);

const outFile =
  process.env.KILN_PROVENANCE_OUT ??
  join(dirname(fileURLToPath(import.meta.url)), '.kiln', 'provenance.json');

export default {
  plugins: [provenancePlugin({ outFile })],
  esbuild: { jsx: 'automatic' },
  server: { host: '127.0.0.1' },
};
