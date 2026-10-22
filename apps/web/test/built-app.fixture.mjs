import { execFileSync } from 'node:child_process';
import { access, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { preview as serveBuild } from 'vite';

const root = fileURLToPath(new URL('..', import.meta.url));
const failureDirectory = fileURLToPath(new URL('../../../reports/check/agent-builder/browser', import.meta.url));

export async function startBuiltApp({ port = 0 } = {}) {
  try {
    await access(join(root, 'dist/index.html'));
  } catch {
    throw new Error('Build dependencies, then prepare the web app: VITE_API_URL= pnpm --filter @tulipfarm/web build');
  }
  const server = await serveBuild({ root, preview: { host: '127.0.0.1', port, strictPort: true }, logLevel: 'error' });
  const address = server.httpServer.address();
  if (!address || typeof address !== 'object') throw new Error('The built web app did not open an HTTP port.');
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise((resolve, reject) => server.httpServer.close(error => (error ? reject(error) : resolve()))),
  };
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
