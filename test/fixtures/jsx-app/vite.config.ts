import { defineConfig } from 'vite';

// Deliberately ordinary. Kiln adds its provenance plugin by wrapping this config
// at run time, so nothing here should know Kiln exists.
export default defineConfig({
  esbuild: { jsx: 'automatic' },
  server: { host: '127.0.0.1' },
});