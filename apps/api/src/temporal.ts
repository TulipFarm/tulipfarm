import { Client, Connection } from '@temporalio/client';
import { temporalClientInterceptor } from '@tulipfarm/observability/temporal';

export function createTemporalClient() {
  const connection = Connection.lazy({ address: process.env.TEMPORAL_ADDRESS ?? '127.0.0.1:7233' });
  const namespace = process.env.TEMPORAL_NAMESPACE ?? 'default';
  return {
    connection,
    namespace,
    client: new Client({ connection, namespace, interceptors: { workflow: [temporalClientInterceptor()] } }),
  };
}
