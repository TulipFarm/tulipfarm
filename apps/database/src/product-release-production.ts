import { randomBytes } from 'node:crypto';
import { type Client } from 'pg';
import { azure } from './config.ts';
import { connectionUrl } from './azure.ts';
import { optionalSecret, readSecret, secretStore } from './secrets.ts';
import { connect } from './postgres.ts';
import { createEmailLogin, encryptedProductKeyIds, inspectEmailLogin } from './product-release-access.ts';
import {
  productEmailRole,
  ProductReleaseError,
  runProductRelease,
  type ProductReleaseCommand,
} from './product-release.ts';

const host = `${azure.serverName}.postgres.database.azure.com`;
function validateUrl(value: string, database: string, role: string) {
  const url = new URL(value);
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    url.hostname !== host ||
    !['', '5432'].includes(url.port) ||
    url.pathname !== `/${database}` ||
    decodeURIComponent(url.username) !== role ||
    decodeURIComponent(url.password).length < 24 ||
    url.search !== '?sslmode=verify-full' ||
    url.hash
  ) {
    throw new ProductReleaseError('Stored product database URL does not match the configured endpoint and role.');
  }
  return url;
}

export async function executeProductionProductRelease(command: ProductReleaseCommand) {
  let client: Client | undefined;
  try {
    const admin = validateUrl(await readSecret('database-admin-url'), 'postgres', azure.administrator);
    admin.pathname = '/tulipfarm';
    client = await connect(admin.href);
    const database = client;
    await database.query('SELECT pg_advisory_lock(734128, 4)');
    return await runProductRelease(command, {
      readSecret: optionalSecret,
      async createSecret(name, value) {
        const current = await optionalSecret(name);
        if (current === value) return;
        if (current !== undefined)
          throw new ProductReleaseError('Secret appeared during preparation. Refusing overwrite.');
        await (await secretStore()).write(name, value);
        if ((await optionalSecret(name)) !== value) throw new ProductReleaseError('Secret creation was not verified.');
      },
      randomHex: () => randomBytes(32).toString('hex'),
      encryptedKeyIds: () => encryptedProductKeyIds(database),
      inspectEmailLogin: () => inspectEmailLogin(database),
      createEmailLogin: password => createEmailLogin(database, password),
      loginUrl: password => connectionUrl(host, 'tulipfarm', productEmailRole, password),
      loginPassword: value => decodeURIComponent(validateUrl(value, 'tulipfarm', productEmailRole).password),
      async verifyEmailLogin(value) {
        validateUrl(value, 'tulipfarm', productEmailRole);
        const scoped = await connect(value);
        try {
          const identity = await scoped.query('SELECT current_user,session_user');
          if (
            identity.rows[0]?.current_user !== productEmailRole ||
            identity.rows[0]?.session_user !== productEmailRole
          ) {
            throw new ProductReleaseError('Email login identity verification failed.');
          }
          await scoped.query('SELECT id FROM app.email_deliveries LIMIT 0');
        } finally {
          await scoped.end();
        }
      },
    });
  } finally {
    await client?.end();
  }
}
