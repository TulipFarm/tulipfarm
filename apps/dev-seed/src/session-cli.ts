import { parseArgs } from 'node:util';
import { Pool } from 'pg';
import { createDevSessions } from '@tulipfarm/api/dev-session';
import { loadLocalEnv, SeedRefused, webOrigin } from './env.ts';
import { signInUrl } from './workspace.ts';

const usage = `Usage: pnpm dev:session [--email dev@tulipfarm.test] [--name "Dev User"] [--redirect /seed-basic] [--json]

Creates the user if needed, mints a real Better Auth session in the local database,
and prints the cookie plus a one-click sign-in URL (needs the API from \`pnpm dev\`).`;

async function main() {
  const { values } = parseArgs({
    options: {
      email: { type: 'string', default: 'dev@tulipfarm.test' },
      name: { type: 'string', default: 'Dev User' },
      redirect: { type: 'string', default: '/' },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help) {
    process.stdout.write(`${usage}\n`);
    return;
  }
  loadLocalEnv();
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, options: '-c search_path=app', max: 2 });
  try {
    const session = await createDevSessions(pool).signIn(values.email, values.name);
    const url = signInUrl(session.user.email, values.redirect);
    const cookies = session.cookies.map(cookie => {
      const [pair = ''] = cookie.split(';');
      const index = pair.indexOf('=');
      return {
        name: pair.slice(0, index),
        value: pair.slice(index + 1),
        domain: 'localhost',
        path: '/',
        httpOnly: true,
        sameSite: 'Lax' as const,
      };
    });
    if (values.json) {
      process.stdout.write(
        `${JSON.stringify({ user: session.user, signInUrl: url, webOrigin: webOrigin(), cookieHeader: session.cookieHeader, cookies }, null, 2)}\n`,
      );
      return;
    }
    process.stdout.write(
      `Signed in ${session.user.name} <${session.user.email}> (${session.user.id})\n\nOpen in a browser (API must be running):\n  ${url}\n\nOr send this Cookie header to http://localhost:3001 or set it on localhost for ${webOrigin()}:\n  ${session.cookieHeader}\n`,
    );
  } finally {
    await pool.end();
  }
}

main().catch(error => {
  process.stderr.write(
    `${error instanceof SeedRefused ? error.message : error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exitCode = 1;
});
