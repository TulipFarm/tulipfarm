import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin, type Rollup } from 'vite';
import { developmentBuild } from '@tulipfarm/build-info';
import { readBuildInfo } from '@tulipfarm/build-info/node';
import { resolveApiOrigin } from './src/lib/api-origin.ts';
import { signInPages } from './src/lib/sign-in-pages.ts';

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

// A stylesheet in <head> holds the first paint until it downloads; after the early composer
// in <body> it lets that composer paint at once. Scripts still wait for it, so the app never shows unstyled.
function stylesAfterEarlyComposer(): Plugin {
  return {
    name: 'styles-after-early-composer',
    transformIndexHtml: {
      order: 'post',
      handler(html) {
        const styles = html.match(/<link rel="stylesheet"[^>]*>/g) ?? [];
        if (!styles.length) return html;
        for (const style of styles) html = html.replace(style, '');
        return html.replace('</body>', `${styles.join('\n')}\n</body>`);
      },
    },
  };
}

// The router finds a page's code, and asks for the session, only after the entry bundle runs.
// An inline script starts the session check at once (lib/auth.ts takes it) and, on sign-in
// pages, preloads the page's chunks and starts the options request (public-query.tsx takes it).
function earlyRequests(): Plugin {
  let base = '/';
  let origin = '';
  return {
    name: 'early-requests',
    configResolved(config) {
      base = config.base;
      const configured = resolveApiOrigin(config.env.VITE_API_URL, config.env.DEV);
      origin = configured ? new URL(configured).origin : '';
    },
    transformIndexHtml: {
      order: 'post',
      handler(_html, { bundle }) {
        if (!bundle) return [];
        const chunks = Object.values(bundle).filter(item => item.type === 'chunk');
        const entry = chunks.find(chunk => chunk.isEntry);
        if (!entry) return [];
        const closure = (names: string[], seen = new Set<string>()) => {
          for (const name of names) {
            if (seen.has(name)) continue;
            seen.add(name);
            const chunk = bundle[name];
            if (chunk?.type === 'chunk') closure(chunk.imports, seen);
          }
          return seen;
        };
        const loaded = closure([entry.fileName]);
        // Builds without a page, such as the build-info tests' stub app, preload nothing for it.
        const files = Object.fromEntries(
          Object.entries(signInPages).flatMap(([path, modules]) => {
            const roots = modules.map(
              module => chunks.find(item => item.moduleIds.some(id => id.endsWith(module)))?.fileName,
            );
            if (roots.some(root => !root)) return [];
            return [[path, [...closure(roots as string[])].filter(file => !loaded.has(file)).map(file => base + file)]];
          }),
        );
        return [
          {
            tag: 'script',
            children:
              `(function(){var o=${JSON.stringify(origin)};` +
              `function g(p,i){var u=new URL(o+p,location.href).href;return{url:u,response:fetch(u,i)}}` +
              `try{window.__tfSession=g('/v1/auth/get-session',{credentials:'include'})}catch(e){}` +
              `var f=${JSON.stringify(files)}[location.pathname.replace(/\\/+$/,'')];if(!f)return;` +
              `f.forEach(function(h){var l=document.createElement('link');l.rel='modulepreload';l.href=h;document.head.appendChild(l)});` +
              `try{var a=g('/v1/auth/options',{credentials:'omit',cache:'no-store'});window.__tfAuthOptions=a;` +
              // The parsed body lets the form render with its sign-in methods on the first paint.
              `a.response.then(function(r){return r.ok?r.clone().json():null}).then(function(d){a.data=d},function(){})}catch(e){}})()`,
            injectTo: 'head',
          },
        ];
      },
    },
  };
}

// Sprout's stylesheet is most of the CSS, and sign-in pages use a handful of its components.
// Those pages load src/sign-in.css, which imports only their component styles, then the full
// stylesheet once the page has loaded; the router waits for it before leaving them. Every rule
// in sign-in.css repeats, in the same order, later in the full stylesheet, so once both load
// the cascade is the full stylesheet's. The build fails if sign-in pages use a Sprout class
// whose file sign-in.css doesn't import, or if its imports leave Sprout's order.
function signInStyles(): Plugin {
  const input = 'src/sign-in.css';
  let root = '';
  let base = '/';
  let enabled = false;
  return {
    name: 'sign-in-styles',
    apply: 'build',
    config(config) {
      root = resolve(config.root ?? '.');
      enabled = existsSync(resolve(root, input));
      if (!enabled) return;
      return {
        build: { rolldownOptions: { input: { index: resolve(root, 'index.html'), 'sign-in': resolve(root, input) } } },
      };
    },
    configResolved(config) {
      base = config.base;
    },
    transformIndexHtml: {
      order: 'post',
      handler(html, { bundle }) {
        if (!enabled || !bundle) return html;
        const asset = Object.values(bundle).find(
          item => item.type === 'asset' && item.originalFileNames.includes(input),
        );
        const link = html.match(/<link rel="stylesheet" crossorigin href="([^"]+)">/);
        if (!asset || !link) throw new Error('sign-in-styles: missing the sign-in or full stylesheet');
        checkSignInStyles(root, bundle);
        const light = base + asset.fileName;
        const paths = Object.fromEntries(Object.keys(signInPages).map(path => [path, 1]));
        const script =
          `<script>(function(){var f=${JSON.stringify(link[1])},s=${JSON.stringify(paths)}[location.pathname.replace(/\\/+$/,'')];` +
          `document.write('<link rel="stylesheet" crossorigin href="'+(s?${JSON.stringify(light)}:f)+'">');if(!s)return;var p;` +
          `window.__tfStyles=function(){return p||(p=new Promise(function(r){var l=document.createElement('link');` +
          `l.rel='stylesheet';l.crossOrigin='';l.href=f;l.onload=l.onerror=function(){r()};document.body.appendChild(l)}))};` +
          `addEventListener('load',function(){window.__tfStyles()})})()</script>`;
        return html.replace(link[0], script);
      },
    },
  };
}

// Code the sign-in pages load up front (lazy parts, like the showcase, wait for the full stylesheet).
function checkSignInStyles(root: string, bundle: Rollup.OutputBundle) {
  const chunks = Object.values(bundle).filter(item => item.type === 'chunk');
  const loaded = new Map<string, Rollup.OutputChunk>();
  const visit = (chunk: Rollup.OutputChunk | undefined) => {
    if (!chunk || loaded.has(chunk.fileName)) return;
    loaded.set(chunk.fileName, chunk);
    for (const name of chunk.imports) visit(chunks.find(item => item.fileName === name));
  };
  const containing = (module: string) => chunks.find(chunk => chunk.moduleIds.some(id => id.endsWith(module)));
  for (const module of ['/src/main.tsx', ...Object.values(signInPages).flat()]) visit(containing(module));

  const read = (file: string) => readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const names = (text: string, pattern: RegExp) => [...text.matchAll(pattern)].map(match => match[1] ?? '');
  const styles = resolve(createRequire(resolve(root, 'package.json')).resolve('@tulipfarm/sprout/styles.css'), '..');
  const order = names(read(resolve(styles, 'index.css')), /@import '\.\/([\w-]+)\.css';/g);
  const imported = names(read(resolve(root, 'src/sign-in.css')), /@tulipfarm\/sprout\/styles\/([\w-]+)\.css/g);

  // A file styles an element when the first part of a selector names only classes the page uses:
  // `.sprout-form .sprout-button` needs forms, `.sprout-button.sprout-board-add` needs boards.
  const withoutArguments = (text: string): string => {
    const next = text.replace(/\([^()]*\)/g, '');
    return next === text ? text : withoutArguments(next);
  };
  const tokens = new Set([...loaded.values()].flatMap(chunk => names(chunk.code, /(sprout-[a-z0-9-]+)/g)));
  // Class names built at runtime, such as `sprout-button-size-${size}`, appear as a prefix ending in `-`.
  const used = (className: string) =>
    tokens.has(className) || [...tokens].some(token => token.endsWith('-') && className.startsWith(token));
  const needed = order.filter(file =>
    names(read(resolve(styles, `${file}.css`)), /([^{};]+)\{/g)
      .flatMap(prelude => withoutArguments(prelude).split(','))
      .map(selector => names(selector.trim().split(/[\s>+~]/)[0] ?? '', /\.(sprout-[\w-]+)/g))
      .some(classes => classes.length > 0 && classes.every(used)),
  );

  const missing = needed.filter(file => !imported.includes(file));
  if (missing.length) throw new Error(`src/sign-in.css must import Sprout styles: ${missing.join(', ')}`);
  const expected = order.filter(file => imported.includes(file));
  if (expected.join() !== imported.join())
    throw new Error(`src/sign-in.css must import Sprout styles in Sprout's order: ${expected.join(', ')}`);
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

// `virtual:emoji-glyphs` maps each Slack emoji short name, including `name::skin-tone-N`, to its
// character. Built from emoji-datasource so the browser loads about 15 KB instead of its full JSON.
function emojiGlyphs(): Plugin {
  const id = 'virtual:emoji-glyphs';
  type Emoji = { unified: string; short_names: string[]; skin_variations?: Record<string, { unified: string }> };
  const glyph = (unified: string) => String.fromCodePoint(...unified.split('-').map(hex => Number.parseInt(hex, 16)));
  return {
    name: 'emoji-glyphs',
    resolveId: source => (source === id ? `\0${id}` : undefined),
    load(source) {
      if (source !== `\0${id}`) return undefined;
      const file = createRequire(import.meta.url).resolve('emoji-datasource/emoji.json');
      const glyphs: Record<string, string> = {};
      for (const emoji of JSON.parse(readFileSync(file, 'utf8')) as Emoji[]) {
        for (const name of emoji.short_names) glyphs[name] = glyph(emoji.unified);
        for (const [tones, variation] of Object.entries(emoji.skin_variations ?? {})) {
          const tone = ['1F3FB', '1F3FC', '1F3FD', '1F3FE', '1F3FF'].indexOf(tones);
          if (tone !== -1) glyphs[`${emoji.short_names[0]}::skin-tone-${tone + 2}`] = glyph(variation.unified);
        }
      }
      return `export default ${JSON.stringify(glyphs)};\n`;
    },
  };
}

export default defineConfig(({ command }) => {
  // Release builds come from the publication controller, which allocates a version.
  const identity =
    command === 'build' && process.env.TULIPFARM_RELEASE_BUILD === '1'
      ? readBuildInfo('web', new URL('./version.json', import.meta.url), true)
      : developmentBuild('web');
  return {
    // Parallel browser tests give each worker its own dependency cache, so one server's re-optimize can't break another's.
    ...(process.env.TULIPFARM_VITE_CACHE_DIR ? { cacheDir: process.env.TULIPFARM_VITE_CACHE_DIR } : {}),
    define: { __BUILD_INFO__: JSON.stringify(identity) },
    plugins: [
      react(),
      tailwindcss(),
      apiPreconnect(),
      earlyRequests(),
      webExtensions(),
      emojiGlyphs(),
      stylesAfterEarlyComposer(),
      signInStyles(),
      {
        name: 'build-identity',
        generateBundle() {
          this.emitFile({ type: 'asset', fileName: 'version.json', source: JSON.stringify(identity) + '\n' });
        },
      },
    ],
    // Lazy chunks can import each other in a cycle (recharts split across `chart` and `surface`).
    // Without strict order, the chunk loaded first runs before its dependency and throws.
    build: {
      rolldownOptions: {
        output: {
          strictExecutionOrder: true,
          // The auth screens page and the sign-in client chunk would both be named `auth`.
          chunkFileNames: chunk =>
            chunk.moduleIds.some(id => id.endsWith('/src/pages/auth.tsx'))
              ? 'assets/auth-screens-[hash].js'
              : 'assets/[name]-[hash].js',
        },
      },
    },
    // Web extensions live in other packages, where pnpm can install a second Sprout or React
    // copy. A second copy has its own React contexts, so its sidebar parts crash outside <Sidebar>.
    resolve: {
      dedupe: ['@tulipfarm/sprout', 'react', 'react-dom'],
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url)),
      },
    },
  };
});
