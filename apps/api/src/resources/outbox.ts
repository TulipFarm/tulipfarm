import type { EventEmitter } from "node:events";
import type { HookExecutor } from "@tulipfarm/sandbox";
import { DOMAIN_EVENTS, type ResourceEventPayload } from "@tulipfarm/storage";

export type { ResourceMutationKind, ResourceSideEffect } from "@tulipfarm/storage";
export {
  RESOURCE_SIDE_EFFECT_STORAGE_STATEMENTS,
  ResourceSideEffectDispatcher,
  ResourceSideEffectOutbox,
  writeResourceSideEffect,
} from "@tulipfarm/storage";

import type { ResourceSideEffect } from "@tulipfarm/storage";
export async function deliverResourceSideEffect(
  effect: ResourceSideEffect,
  hookExecutor: HookExecutor | undefined,
  events: EventEmitter | undefined
): Promise<void> {
  if (effect.afterHook && hookExecutor)
    await hookExecutor.runAfterHook(
      effect.afterHook.source,
      effect.resourceType,
      effect.record,
      effect.afterHook.hash
    );
  const payload: ResourceEventPayload = {
    resourceType: effect.resourceType,
    resourceId: effect.resourceId,
    record: effect.record,
    ...(effect.actorId === undefined ? {} : { actorId: effect.actorId }),
  };
  events?.emit(
    effect.kind === "create"
      ? DOMAIN_EVENTS.RESOURCE_CREATED
      : effect.kind === "update"
        ? DOMAIN_EVENTS.RESOURCE_UPDATED
        : DOMAIN_EVENTS.RESOURCE_DELETED,
    payload
  );
}
