import { loadSecretFiles } from '@tulipfarm/config/secret-files';
import { createBrowserHost } from './host.ts';
import { createBrowserHostServer } from './server.ts';

const env = process.env;
loadSecretFiles(env, ['BROWSER_HOST_TOKEN']);
const token = env.BROWSER_HOST_TOKEN?.trim();
if (!token || token.length < 32) throw new Error('Set BROWSER_HOST_TOKEN to a random value of at least 32 characters');
const port = Number(env.BROWSER_HOST_PORT ?? 3010);
const minutes = (value: string | undefined, fallback: number) => (value ? Number(value) : fallback) * 60_000;

const host = await createBrowserHost({
  executablePath: env.CHROMIUM_EXECUTABLE_PATH || undefined,
  sandbox: env.CHROMIUM_SANDBOX === 'true',
  maxSessions: Number(env.BROWSER_HOST_MAX_SESSIONS ?? 8),
  maxSessionsPerWorkspace: Number(env.BROWSER_MAX_SESSIONS_PER_WORKSPACE ?? 3),
  idleMs: minutes(env.BROWSER_HOST_IDLE_MINUTES, 10),
  holdMs: minutes(env.BROWSER_HOST_HOLD_MINUTES, 24 * 60),
  allowPrivateNetworks: env.BROWSER_HOST_ALLOW_PRIVATE_NETWORKS === 'true',
});
const sweeper = setInterval(() => void host.sweep(), 30_000);
const server = createBrowserHostServer(host, token);
server.listen(port, () => console.log(`browser host listening on ${port}`));

for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.once(signal, () => {
    clearInterval(sweeper);
    server.close();
    void host.shutdown().finally(() => process.exit(0));
  });
