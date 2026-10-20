import { Client } from 'pg';
import { z } from 'zod';
import { provisionTableRegistry } from '@tulipfarm/workspaces/table-registry';

async function run() {
  const [input, ...extra] = process.argv.slice(2);
  const capability = z.enum(['authoring', 'confirmation', 'migration']).parse(input);
  if (extra.length) throw new Error('Expected one registry capability');
  const variable =
    capability === 'authoring'
      ? 'WORKSPACE_AUTHORING_DATABASE_URL'
      : `WORKSPACE_${capability.toUpperCase()}_REGISTRY_DATABASE_URL`;
  const target = new URL(z.url().parse(process.env[variable]));
  const provisioning = new URL(z.url().parse(process.env.WORKSPACE_PROVISIONING_DATABASE_URL));
  for (const url of [target, provisioning]) {
    if (
      !['postgres:', 'postgresql:'].includes(url.protocol) ||
      !url.hostname ||
      !url.username ||
      !url.password ||
      url.pathname.length < 2 ||
      url.hash ||
      [...url.searchParams.keys()].some(key => key !== 'sslmode') ||
      url.searchParams.getAll('sslmode').length > 1
    ) {
      throw new Error('Expected a canonical PostgreSQL endpoint and credential');
    }
  }
  if (
    target.hostname !== provisioning.hostname ||
    (target.port || '5432') !== (provisioning.port || '5432') ||
    decodeURIComponent(target.pathname) !== decodeURIComponent(provisioning.pathname)
  )
    throw new Error('Registry and provisioner must address the same database');
  if (decodeURIComponent(target.username) === decodeURIComponent(provisioning.username))
    throw new Error('Registry requires a separate restricted credential');
  const client = new Client({
    connectionString: provisioning.href,
    connectionTimeoutMillis: 5000,
    statement_timeout: 10000,
  });
  client.on('error', () => undefined);
  try {
    await client.connect();
    await provisionTableRegistry(client, {
      capability,
      role: decodeURIComponent(target.username),
      password: decodeURIComponent(target.password),
    });
    process.stdout.write(`${JSON.stringify({ capability, status: 'provisioned' })}\n`);
  } finally {
    await client.end();
  }
}

run().catch(() => {
  process.stderr.write('Table registry provisioning failed. Check the scoped connection configuration.\n');
  process.exitCode = 1;
});
