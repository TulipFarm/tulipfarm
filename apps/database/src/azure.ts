import { isIPv4 } from 'node:net';
import { PostgreSQLManagementFlexibleServerClient } from '@azure/arm-postgresql-flexible';
import { AzureCliCredential } from '@azure/identity';
import { azure, databaseProvider, DatabaseError, hasStatus } from './config.ts';
import { generatedPassword, readSecret, saveSecret } from './secrets.ts';

let management: PostgreSQLManagementFlexibleServerClient | undefined;
export function azureManagement() {
  if (databaseProvider() !== 'azure') throw new DatabaseError('Select DATABASE_PROVIDER=azure for Azure management.');
  management ??= new PostgreSQLManagementFlexibleServerClient(new AzureCliCredential(), azure.subscriptionId);
  return management;
}

export function connectionUrl(host: string, database: string, username: string, secret: string) {
  const url = new URL(`postgresql://${host}:5432/${database}`);
  url.username = username;
  url.password = secret;
  url.searchParams.set('sslmode', 'verify-full');
  return url.href;
}

export async function allowIp(ip: string) {
  if (!isIPv4(ip) || ip === '0.0.0.0') throw new DatabaseError('Supply one public IPv4 address with --allow-ip.');
  const management = azureManagement();
  await management.firewallRules.beginCreateOrUpdateAndWait(azure.resourceGroup, azure.serverName, 'developer', {
    startIpAddress: ip,
    endIpAddress: ip,
  });
  process.stdout.write('Updated developer firewall rule to the supplied IP.\n');
}

export async function provision(ip: string) {
  if (!isIPv4(ip) || ip === '0.0.0.0') throw new DatabaseError('Supply one public IPv4 address with --allow-ip.');
  const management = azureManagement();
  let server;
  try {
    server = await management.servers.get(azure.resourceGroup, azure.serverName);
  } catch (error) {
    if (!hasStatus(error, 404)) throw error;
  }
  if (!server) {
    const adminPassword = await generatedPassword('postgres-admin-password');
    process.stdout.write(`Creating ${azure.serverName} in ${azure.location}; this can take several minutes.\n`);
    server = await management.servers.beginCreateOrUpdateAndWait(azure.resourceGroup, azure.serverName, {
      location: azure.location,
      version: azure.version,
      administratorLogin: azure.administrator,
      administratorLoginPassword: adminPassword,
      sku: { name: azure.sku, tier: 'GeneralPurpose' },
      storage: { storageSizeGB: azure.storageGiB, autoGrow: 'Enabled' },
      backup: { backupRetentionDays: 7, geoRedundantBackup: 'Disabled' },
      highAvailability: { mode: 'Disabled' },
      network: { publicNetworkAccess: 'Enabled' },
      authConfig: { passwordAuth: 'Enabled', activeDirectoryAuth: 'Disabled' },
      tags: { project: 'tulipfarm-cloud', environment: 'production' },
    });
  }
  if (server.state !== 'Ready' || !server.fullyQualifiedDomainName) {
    throw new DatabaseError(`Server is ${server.state}; wait for it to be Ready before rerunning.`);
  }
  if (server.version !== azure.version || server.administratorLogin !== azure.administrator) {
    throw new DatabaseError(
      'Existing server differs from the configured version or administrator; inspect before proceeding.',
    );
  }
  await allowIp(ip);
  await saveSecret(
    'database-admin-url',
    connectionUrl(
      server.fullyQualifiedDomainName,
      'postgres',
      azure.administrator,
      await readSecret('postgres-admin-password'),
    ),
  );
  process.stdout.write(`Server ready: ${server.fullyQualifiedDomainName}\n`);
}
