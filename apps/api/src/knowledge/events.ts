import type { EventEmitter } from "node:events";
import {
  type ConversationCompletedPayload,
  DOMAIN_EVENTS,
  type ResourceEventPayload,
} from "../domain-events";
import { type Enqueuer, enqueueIndex } from "./indexing";

function fireAndForget(p: Promise<unknown>): void {
  p.catch((err) =>
    console.error(`[knowledge] enqueue failed: ${err instanceof Error ? err.message : String(err)}`)
  );
}

/**
 * Wire the knowledge source adapters (KN-V1-003) to the domain-event bus: resource
 * writes and completed conversations enqueue idempotent indexing jobs (AC-V1-002).
 */
export function subscribeKnowledgeIndexing(emitter: EventEmitter, boss: Enqueuer): void {
  const onResource = (p: ResourceEventPayload): void => {
    fireAndForget(
      enqueueIndex(boss, {
        kind: "resource",
        resourceType: p.resourceType,
        resourceId: p.resourceId,
        record: p.record,
      })
    );
  };
  emitter.on(DOMAIN_EVENTS.RESOURCE_CREATED, onResource);
  emitter.on(DOMAIN_EVENTS.RESOURCE_UPDATED, onResource);
  emitter.on(DOMAIN_EVENTS.CONVERSATION_COMPLETED, (p: ConversationCompletedPayload): void => {
    fireAndForget(enqueueIndex(boss, { kind: "conversation", conversationId: p.conversationId }));
  });
}
