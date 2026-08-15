import type { EventEmitter } from "node:events";
import {
  type ConversationCreatedPayload,
  DOMAIN_EVENTS,
  type ResourceEventPayload,
} from "@tulipfarm/storage";
import type { ActivityService } from "./service";

function fireAndForget(p: Promise<unknown>): void {
  p.catch((err) =>
    console.error(
      `[activity] subscriber failed: ${err instanceof Error ? err.message : String(err)}`
    )
  );
}

function describeResource(record: Record<string, unknown>, resourceId: string): string {
  if (typeof record.title === "string" && record.title.length > 0) return record.title;
  if (typeof record.name === "string" && record.name.length > 0) return record.name;
  return resourceId;
}

/** Activity writes are best-effort; completion events are skipped to avoid turn-level noise. */
export function subscribeActivityLogging(emitter: EventEmitter, activity: ActivityService): void {
  const onResource =
    (verb: "created" | "updated") =>
    (p: ResourceEventPayload): void => {
      const label = describeResource(p.record, p.resourceId);
      fireAndForget(
        activity.record({
          category: "resource",
          action: `resource.${verb}`,
          actorId: p.actorId ?? null,
          targetType: "resource",
          targetId: p.resourceId,
          summary: `${verb === "created" ? "Created" : "Updated"} ${p.resourceType} ${label}`,
          metadata: { resourceType: p.resourceType },
        })
      );
    };
  emitter.on(DOMAIN_EVENTS.RESOURCE_CREATED, onResource("created"));
  emitter.on(DOMAIN_EVENTS.RESOURCE_UPDATED, onResource("updated"));
  emitter.on(DOMAIN_EVENTS.CONVERSATION_CREATED, (p: ConversationCreatedPayload): void => {
    fireAndForget(
      activity.record({
        category: "chat",
        action: "conversation.created",
        actorId: p.actorId ?? null,
        targetType: "conversation",
        targetId: p.conversationId,
        summary: p.agentId ? `Started a chat with ${p.agentId}` : "Started a chat",
        metadata: p.agentId ? { agentId: p.agentId } : {},
      })
    );
  });
}
