import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';
import { developmentBuild } from '@tulipfarm/build-info';
import { readBuildInfo } from '@tulipfarm/build-info/node';
import { resolveApiOrigin } from './src/lib/api-origin.ts';

// Opens the API integration while the entry bundle downloads. The session check uses
// credentials, so the hint must use the credentialed connection pool to be reused.
function apiPreconnect(): Plugin {
  let origin: string | undefined;
  return {
    name: 'api-preconnect',
    configResolved(config) {
      const configured = resolveApiOrigin(config.env.VITE_API_URL, config.env.DEV);
      origin = configured && new URL(configured).origin;
    },
    transformIndexHtml: () =>
      origin
        ? [
            {
              tag: 'link',
              attrs: { rel: 'preconnect', href: origin, crossorigin: 'use-credentials' },
              injectTo: 'head-prepend',
            },
          ]
        : [],
  };
}

// Web extensions are chosen at build time: VITE_TULIPFARM_WEB_EXTENSIONS is a comma-separated
// list of module specifiers (package names, or paths relative to apps/web), each default-exporting
// a web extension. `virtual:tulipfarm-web-extensions` imports them in order; unset means none.
function webExtensions(): Plugin {
  const id = 'virtual:tulipfarm-web-extensions';
  let specifiers: string[] = [];
  return {
    name: 'tulipfarm-web-extensions',
    configResolved(config) {
      specifiers = (config.env.VITE_TULIPFARM_WEB_EXTENSIONS ?? '')
        .split(',')
        .map((item: string) => item.trim())
        .filter(Boolean)
        .map((item: string) => (item.startsWith('.') ? resolve(config.root, item) : item));
    },
    resolveId: source => (source === id ? `\0${id}` : undefined),
    load: source =>
      source === `\0${id}`
        ? specifiers
            .map((specifier, index) => `import extension${index} from ${JSON.stringify(specifier)};\n`)
            .join('') + `export default [${specifiers.map((_, index) => `extension${index}`).join(', ')}];\n`
        : undefined,
  };
}

export default defineConfig(({ command }) => {
  // Release builds come from the publication controller, which allocates a version.
  const identity =
    command === 'build' && process.env.TULIPFARM_RELEASE_BUILD === '1'
      ? readBuildInfo('web', new URL('./version.json', import.meta.url), true)
      : developmentBuild('web');
  return {
    define: { __BUILD_INFO__: JSON.stringify(identity) },
    plugins: [
      react(),
      tailwindcss(),
      apiPreconnect(),
      webExtensions(),
      {
        name: 'build-identity',
        generateBundle() {
          this.emitFile({ type: 'asset', fileName: 'version.json', source: JSON.stringify(identity) + '\n' });
        },
      },
    ],
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url)),
      },
    },
  };
});
