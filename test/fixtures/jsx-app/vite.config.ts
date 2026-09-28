import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { provenancePlugin } from '../../../src/provenance/plugin.ts';

const provenance = provenancePlugin({
  outFile: join(dirname(fileURLToPath(import.meta.url)), '.kiln', 'provenance.json'),
});

export default {
  plugins: [provenance],
  esbuild: { jsx: 'automatic' },
  server: { host: '127.0.0.1' },
};
