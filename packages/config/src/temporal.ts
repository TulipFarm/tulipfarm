import { loadSecretFiles } from './secret-files.ts';

export function temporalConnectionOptions(env: NodeJS.ProcessEnv = process.env) {
  loadSecretFiles(env, ['TEMPORAL_API_KEY']);
  const tls = env.TEMPORAL_TLS;
  if (tls && tls !== 'true' && tls !== 'false') throw new Error('TEMPORAL_TLS must be true or false');
  return {
    address: env.TEMPORAL_ADDRESS ?? '127.0.0.1:7233',
    ...(tls ? { tls: tls === 'true' } : {}),
    ...(env.TEMPORAL_API_KEY ? { apiKey: env.TEMPORAL_API_KEY } : {}),
  };
}
