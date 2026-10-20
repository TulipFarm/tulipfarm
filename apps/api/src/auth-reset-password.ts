// Prints a one-time password reset link for an instance without an email transport.
// Source checkout: pnpm auth:reset-password <email>
// Self-host: docker compose exec api node --env-file=/run/tulipfarm/api.env dist/auth-reset-password.js <email>
import '@tulipfarm/config/load-secret-files';
import { parseArgs } from 'node:util';
import { Pool } from 'pg';
import { z } from 'zod';
import { authConfig, createAuth } from './better-auth.ts';

const usage = `Usage: pnpm auth:reset-password <email>

Prints a one-time link that sets a new password for <email>. It expires in 1 hour.
Send it to the person privately. Requires AUTH_EMAIL_PASSWORD=true and DATABASE_URL.`;

export async function issuePasswordResetLink(pool: Pool, email: string) {
  if (!authConfig().emailPassword) throw new Error('Password sign-in is off. Set AUTH_EMAIL_PASSWORD=true.');
  const address = z.email().parse(email.trim().toLowerCase(), { error: () => 'Enter a valid email address.' });
  const known = await pool.query('SELECT 1 FROM app.users WHERE lower(email) = $1', [address]);
  if (!known.rowCount) throw new Error(`No account uses ${address}.`);
  let link: string | undefined;
  const auth = createAuth(
    pool,
    async () => {},
    async () => {},
    async ({ url }) => {
      link = url;
    },
  );
  await auth.api.requestPasswordReset({
    headers: new Headers({ origin: authConfig().webOrigin }),
    body: { email: address },
  });
  if (!link) throw new Error('Better Auth did not issue a reset link');
  return link;
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { help: { type: 'boolean', short: 'h', default: false } },
  });
  if (values.help || positionals.length !== 1) {
    process.stdout.write(`${usage}\n`);
    if (!values.help) process.exitCode = 2;
    return;
  }
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL ?? 'postgresql://tulipfarm:local-tulipfarm@127.0.0.1:5432/tulipfarm',
    options: '-c search_path=app',
    max: 1,
  });
  try {
    const link = await issuePasswordResetLink(pool, positionals[0]!);
    process.stdout.write(
      `Password reset link for ${positionals[0]!.trim().toLowerCase()} (one use, expires in 1 hour):\n${link}\n`,
    );
  } finally {
    await pool.end();
  }
}

if (import.meta.main)
  main().catch(error => {
    process.stderr.write(
      `${error instanceof z.ZodError ? error.issues[0]?.message : error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
