import { z } from 'zod';
import type { FeatureScope } from './scope';

const scopeSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('account'), userId: z.string().min(1) }),
  z.strictObject({
    kind: z.literal('workspace'),
    userId: z.string().min(1),
    workspaceId: z.string().min(1),
    membershipId: z.string().min(1),
  }),
]);
const eventSchema = z.strictObject({
  version: z.literal(1),
  id: z.string().min(1),
  sessionId: z.string().min(1),
  scope: scopeSchema,
  kind: z.enum(['change', 'conceal', 'denied', 'logout']),
  // Serialized key prefixes only. Never send query results or credentials.
  keys: z.array(z.array(z.json())).max(100),
});
export type QueryNotice = z.infer<typeof eventSchema>;

export function queryNotifications(receive: (event: QueryNotice) => void, sessionId: string) {
  let channel: BroadcastChannel | undefined;
  const seen = new Set<string>();
  try {
    if (typeof window !== 'undefined' && typeof BroadcastChannel !== 'undefined')
      channel = new BroadcastChannel('tulipfarm:query:v1');
  } catch {
    /* Memory-only operation remains available. */
  }
  if (channel)
    channel.onmessage = event => {
      const parsed = eventSchema.safeParse(event.data);
      if (!parsed.success || seen.has(parsed.data.id)) return;
      seen.add(parsed.data.id);
      if (seen.size > 512) {
        const first = seen.values().next().value;
        if (first) seen.delete(first);
      }
      receive(parsed.data);
    };
  return {
    send(scope: FeatureScope, kind: QueryNotice['kind'], keys: readonly (readonly unknown[])[] = []) {
      const parsed = eventSchema.safeParse({ version: 1, id: crypto.randomUUID(), sessionId, scope, kind, keys });
      if (parsed.success) {
        try {
          channel?.postMessage(parsed.data);
        } catch {
          /* Cross-tab delivery is best effort. */
        }
      }
    },
    close: () => channel?.close(),
  };
}
