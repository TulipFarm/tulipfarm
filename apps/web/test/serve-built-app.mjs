import { startBuiltApp } from './built-app.fixture.mjs';

const args = process.argv.slice(2);
let host = '127.0.0.1';
let port = 0;

for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--host' && args[i + 1]) {
    host = args[i + 1];
    i += 1;
  } else if (args[i] === '--port' && args[i + 1]) {
    port = Number(args[i + 1]);
    i += 1;
  }
}

const app = await startBuiltApp({
  host,
  port,
  apiUrl: process.env.VITE_API_URL || undefined,
  supportEmail: process.env.VITE_SUPPORT_EMAIL || undefined,
  devMode: true,
});

process.stdout.write(`Local: ${app.origin}/\n`);

const shutdown = async () => {
  await app.close().catch(() => {});
  process.exit(0);
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
