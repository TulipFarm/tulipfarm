import { execFileSync } from 'node:child_process';
import { access, mkdir, readFile, stat } from 'node:fs/promises';
import { createServer, request as httpRequest } from 'node:http';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const distDir = resolve(root, 'dist');
const failureDirectory = fileURLToPath(new URL('../../../reports/check/agent-builder/browser', import.meta.url));

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

export async function startBuiltApp({ host = '127.0.0.1', port = 0, apiUrl, supportEmail, devMode = false } = {}) {
  const serveDir = devMode ? resolve(root, 'dist-test') : distDir;
  const indexFile = join(serveDir, 'index.html');
  try {
    await access(indexFile);
  } catch {
    const cmd = devMode
      ? 'TULIPFARM_BROWSER_TEST_BUILD=1 VITE_API_URL= pnpm --filter @tulipfarm/web build'
      : 'VITE_API_URL= pnpm --filter @tulipfarm/web build';
    throw new Error(`Build dependencies, then prepare the web app: ${cmd}`);
  }
  const rawIndexHtml = await readFile(indexFile, 'utf8');
  const scripts = [];
  if (devMode && apiUrl) scripts.push(`window.__TF_API_ORIGIN__=${JSON.stringify(apiUrl)};`);
  if (devMode && supportEmail) scripts.push(`window.__TF_SUPPORT_EMAIL__=${JSON.stringify(supportEmail)};`);
  const indexHtml = scripts.length
    ? Buffer.from(rawIndexHtml.replace('<head>', `<head><script>${scripts.join('')}</script>`))
    : Buffer.from(rawIndexHtml);
  const upstream = apiUrl ? new URL(apiUrl) : null;
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (upstream && url.pathname.startsWith('/v1/')) {
        const proxyReq = httpRequest(
          {
            hostname: upstream.hostname,
            port: upstream.port || (upstream.protocol === 'https:' ? 443 : 80),
            method: req.method,
            path: url.pathname + url.search,
            headers: { ...req.headers, host: upstream.host },
          },
          proxyRes => {
            res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
            proxyRes.pipe(res);
          },
        );
        proxyReq.on('error', error => {
          if (!res.headersSent) res.writeHead(502);
          res.end(String(error));
        });
        req.pipe(proxyReq);
        return;
      }
      const pathname = decodeURIComponent(url.pathname);
      const candidate = resolve(serveDir, `.${pathname}`);
      if (candidate.startsWith(serveDir + '/') || candidate === serveDir) {
        const info = await stat(candidate).catch(() => null);
        if (info?.isFile()) {
          res.writeHead(200, { 'content-type': mimeTypes[extname(candidate)] ?? 'application/octet-stream' });
          res.end(await readFile(candidate));
          return;
        }
      }
      if (pathname.startsWith('/assets/')) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(indexHtml);
    } catch (error) {
      if (!res.headersSent) res.writeHead(500);
      res.end(String(error));
    }
  });
  await new Promise((resolveListen, rejectListen) =>
    server.once('error', rejectListen).listen(port, host, resolveListen),
  );
  const address = server.address();
  if (!address || typeof address !== 'object') throw new Error('The built web app did not open an HTTP port.');
  const origin = `http://${host}:${address.port}`;
  return {
    origin,
    httpServer: server,
    close: () =>
      new Promise((resolveClose, rejectClose) => {
        server.closeAllConnections?.();
        server.close(error => (error ? rejectClose(error) : resolveClose()));
      }),
  };
}

export async function createBuiltAppServer(options = {}) {
  const host = options.server?.host || '127.0.0.1';
  const port = options.server?.port ?? 0;
  let running = null;
  const facade = {
    httpServer: null,
    resolvedUrls: null,
    async listen() {
      running = await startBuiltApp({ host, port, devMode: true });
      facade.httpServer = running.httpServer;
      facade.resolvedUrls = { local: [`${running.origin}/`], network: [] };
      return facade;
    },
    async close() {
      if (running) {
        await running.close();
        running = null;
      }
    },
  };
  return facade;
}

export function builderBrowserOptions(port = process.env.AGENT_BUILDER_CDP_PORT) {
  return { headless: process.env.AGENT_BUILDER_HEADED !== '1', args: port ? [`--remote-debugging-port=${port}`] : [] };
}

export async function captureBuilderScreenshot(page, name) {
  const directory = process.env.AGENT_BUILDER_SCREENSHOTS;
  if (!directory) return;
  await mkdir(directory, { recursive: true });
  const path = join(directory, `${name}.png`);
  if (process.env.AGENT_BUILDER_CDP_PORT) {
    execFileSync(
      'agent-browser',
      ['--session', 'agent-builder-regression', '--cdp', process.env.AGENT_BUILDER_CDP_PORT, 'screenshot', path],
      { stdio: 'pipe' },
    );
  } else await page.screenshot({ path, fullPage: true });
}

export async function captureBrowserFailure(page, name) {
  try {
    if (!page || page.isClosed()) return;
    await mkdir(failureDirectory, { recursive: true });
    await page.screenshot({ path: join(failureDirectory, `${name}.png`), fullPage: true });
  } catch (error) {
    console.error(`Could not capture ${name}:`, error);
  }
}
