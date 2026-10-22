import { Client, Connection } from '@temporalio/client';
import { temporalConnectionOptions } from '@tulipfarm/config/temporal';
import { temporalClientInterceptor } from '@tulipfarm/observability/temporal';

export function createTemporalClient() {
  const connection = Connection.lazy(temporalConnectionOptions());
  const namespace = process.env.TEMPORAL_NAMESPACE ?? 'default';
  return {
    connection,
    namespace,
    client: new Client({ connection, namespace, interceptors: { workflow: [temporalClientInterceptor()] } }),
  };
}
