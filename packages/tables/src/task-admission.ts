import { AccessDenied } from '@tulipfarm/access';
import { canonicalJson } from './canonical.ts';
import type { TableTransaction } from './service-store.ts';

type Admission = { workspaceId: string; runId: string; recordId: string; call: unknown };
const capabilities = new WeakMap<object, { client: TableTransaction['client']; schema: string; admission: string }>();

// Only the trusted task writer issues capabilities, after admission under transaction locks.
export async function withTaskMutation<T>(
  tx: TableTransaction,
  admission: Admission,
  operation: (capability: object) => Promise<T>,
): Promise<T> {
  const capability = Object.freeze({});
  capabilities.set(capability, { client: tx.client, schema: tx.schema, admission: canonicalJson(admission) });
  try {
    return await operation(capability);
  } finally {
    capabilities.delete(capability);
  }
}

export function consumeTaskMutation(tx: TableTransaction, admission: Admission, capability?: object) {
  const admitted = capability && capabilities.get(capability);
  if (
    !admitted ||
    admitted.client !== tx.client ||
    admitted.schema !== tx.schema ||
    admitted.admission !== canonicalJson(admission)
  )
    throw new AccessDenied();
  capabilities.delete(capability);
}
