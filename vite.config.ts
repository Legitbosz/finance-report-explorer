import { defineConfig, type Plugin } from 'vite';
import path from 'node:path';

function silenceViteWsErrorsPlugin(): Plugin {
  return {
    name: 'silence-vite-ws-errors',
    enforce: 'pre',
    transform(code, id) {
      if (!id.includes('vite/dist/client/client.mjs') && !id.endsWith('/@vite/client')) {
        return null;
      }
      let next = code.replace(
        /console\.error\(\s*`\[vite\] failed to connect to websocket \(\$\{e\}\)\. `\s*\);\s*throw e;/g,
        'return;'
      );
      next = next.replace(
        /console\.error\(\s*`\[vite\] failed to connect to websocket[^`]*`\s*\);/g,
        '/* [vite] websocket connection error silenced */'
      );
      if (next === code) {
        return null;
      }
      return { code: next, map: null };
    },
  };
}

export default defineConfig({
  root: '.',
  base: './',
  publicDir: 'public',
  plugins: [silenceViteWsErrorsPlugin()],
  resolve: {
    alias: {
      '@contracts': path.resolve(__dirname, 'contracts'),
      '@pipeline': path.resolve(__dirname, 'pipeline'),
      '@src': path.resolve(__dirname, 'src'),
      '@data': path.resolve(__dirname, 'data'),
      '@story': path.resolve(__dirname, 'story'),
    },
  },
  server: {
    port: 3000,
    host: '0.0.0.0',
    allowedHosts: true,
    hmr: process.env.DISABLE_HMR !== 'true',
  },
  preview: {
    port: 3000,
    host: '0.0.0.0',
    allowedHosts: true,
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    chunkSizeWarningLimit: 650,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules')) {
            return 'vendor';
          }
          if (id.includes('/data/transactions.json')) {
            return 'transactions';
          }
          if (id.includes('/data/') || id.includes('/story/')) {
            return 'data';
          }
          return undefined;
        },
      },
    },
  },
});
