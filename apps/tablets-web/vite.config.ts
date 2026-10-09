/**
 * Vite (plan section 3): the built SPA is served by the tablets server from the same origin as the API, under a
 * strict CSP, so the modulePreload polyfill (an inline script) is off and a node built-in anywhere in the
 * bundle fails the build (CI runs `pnpm build:web`). Dev servers proxy /api to one installation each
 * (5173 -> GMP 3001, 5174 -> sandbox 3011) and present the server's own origin, so the exact-Origin check holds.
 */
import { builtinModules } from 'node:module';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

const NODE_BUILTINS = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)]);

function noNodeBuiltins(): Plugin {
  return {
    name: 'ebmr-no-node-builtins',
    enforce: 'pre',
    resolveId(source, importer) {
      if (NODE_BUILTINS.has(source) || source.startsWith('node:')) {
        this.error(`browser code must not import the node built-in "${source}" (imported by ${importer ?? 'an entry'})`);
      }
      return null;
    },
  };
}

const api = process.env['EBMR_API_ORIGIN'] ?? 'http://localhost:3001';

export default defineConfig({
  plugins: [noNodeBuiltins(), react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: true,
    modulePreload: { polyfill: false },
    chunkSizeWarningLimit: 2000,
  },
  server: {
    port: Number(process.env['EBMR_WEB_PORT'] ?? 5173),
    strictPort: true,
    proxy: {
      '/api': {
        target: api,
        changeOrigin: true,
        configure: (proxy) => {
          proxy.on('proxyReq', (req) => {
            req.setHeader('origin', api);
          });
        },
      },
    },
  },
});
