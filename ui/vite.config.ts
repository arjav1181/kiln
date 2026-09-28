import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  root: new URL('.', import.meta.url).pathname,
  plugins: [react()],
  base: '/',
  build: {
    outDir: new URL('./dist', import.meta.url).pathname,
    emptyOutDir: true,
    target: 'es2023',
  },
});
