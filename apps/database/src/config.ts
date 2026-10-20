export const azure = {
  subscriptionId: '8908cccf-f477-425f-94b9-376dc1305671',
  resourceGroup: 'rg-tulipfarm-cloud-westus',
  serverName: 'tulipfarm-cloud',
  location: 'westus',
  version: '18',
  administrator: 'tfadmin',
  sku: 'Standard_D2ds_v5',
  storageGiB: 32,
};

export type Extension = { name: string; schema: string; minimumVersion: string };
export const extensions: Extension[] = [{ name: 'vector', schema: 'extensions', minimumVersion: '0.8.0' }];

export class DatabaseError extends Error {}

export function databaseProvider(env: NodeJS.ProcessEnv = process.env) {
  const provider = env.DATABASE_PROVIDER || 'postgres';
  if (provider !== 'postgres' && provider !== 'azure')
    throw new DatabaseError('DATABASE_PROVIDER must be postgres or azure.');
  return provider;
}

export function hasStatus(error: unknown, status: number) {
  return typeof error === 'object' && error !== null && 'statusCode' in error && error.statusCode === status;
}
