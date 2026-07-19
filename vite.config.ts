import { defineConfig } from 'vite';

export default defineConfig(({ mode }) => ({
  // GitHub Pages serves project sites from /<repository>/. Keep the local
  // development URL at / while emitting production assets for that subpath.
  base: mode === 'production' ? '/astral_arena/' : '/',
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          three: ['three'],
        },
      },
    },
  },
  server: {
    port: 4173,
  },
  preview: {
    port: 4173,
  },
}));
