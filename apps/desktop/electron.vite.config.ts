import { resolve } from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import type { Plugin, Rollup } from 'vite';

type RollupOptions = Rollup.RollupOptions;

/**
 * Injects the Content-Security-Policy meta tag. Production is strict; the dev
 * server additionally needs inline scripts (React Fast Refresh preamble) and a
 * websocket connection for HMR.
 */
function contentSecurityPolicy(): Plugin {
  let isDev = false;
  return {
    name: 'content-security-policy',
    configResolved(config) {
      isDev = config.command === 'serve';
    },
    transformIndexHtml() {
      const directives = [
        "default-src 'self'",
        isDev ? "script-src 'self' 'unsafe-inline'" : "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data:",
        "font-src 'self'",
        isDev ? "connect-src 'self' ws:" : "connect-src 'self'",
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'none'",
        "frame-src 'none'",
      ];
      return [
        {
          tag: 'meta',
          attrs: { 'http-equiv': 'Content-Security-Policy', content: directives.join('; ') },
          injectTo: 'head-prepend',
        },
      ];
    },
  };
}

/**
 * Some dependencies (currently zod) ship `@__PURE__` comments in positions Rollup
 * cannot use. Rollup drops them harmlessly; hide that noise but keep every other warning.
 */
const ignoreDependencyAnnotationWarnings: RollupOptions['onwarn'] = (warning, warn) => {
  if (warning.code === 'INVALID_ANNOTATION' && warning.id?.includes('node_modules')) return;
  warn(warning);
};

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { main: resolve(__dirname, 'src/main/main.ts') },
        onwarn: ignoreDependencyAnnotationWarnings,
      },
    },
  },
  preload: {
    // Sandboxed preloads cannot require() arbitrary modules, so everything is bundled.
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: { input: { preload: resolve(__dirname, 'src/preload/preload.ts') } },
    },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    resolve: {
      alias: { '@': resolve(__dirname, 'src/renderer/src') },
      dedupe: ['react', 'react-dom'],
    },
    plugins: [react(), tailwindcss(), contentSecurityPolicy()],
    build: {
      // electron-vite does not minify by default; the renderer is the bundle worth shrinking.
      minify: 'esbuild',
      // Loaded from local disk, not over the network: Vite's 500 kB web heuristic doesn't apply.
      chunkSizeWarningLimit: 1024,
      rollupOptions: {
        input: resolve(__dirname, 'src/renderer/index.html'),
        onwarn: ignoreDependencyAnnotationWarnings,
      },
    },
  },
});
