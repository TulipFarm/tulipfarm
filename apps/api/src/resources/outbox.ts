import type { EventEmitter } from "node:events";
import type { HookExecutor } from "@tulipfarm/sandbox";
import {
  DOMAIN_EVENTS,
  RESOURCE_SIDE_EFFECT_STORAGE_STATEMENTS,
  type ResourceEventPayload,
  ResourceSideEffectDispatcher,
  ResourceSideEffectOutbox,
} from "@tulipfarm/storage";
import type { Queryable } from "../db";

export type { ResourceMutationKind, ResourceSideEffect } from "@tulipfarm/storage";
export {
  RESOURCE_SIDE_EFFECT_STORAGE_STATEMENTS,
  ResourceSideEffectDispatcher,
  ResourceSideEffectOutbox,
  writeResourceSideEffect,
} from "@tulipfarm/storage";

import type { ResourceSideEffect } from "@tulipfarm/storage";

/** Binds a delivered Record mutation to any matching event Trigger. */
export interface ResourceTriggerDispatch {
  dispatchResourceMutation(effect: ResourceSideEffect, outboxId: string): Promise<unknown>;
}

export async function deliverResourceSideEffect(
  effect: ResourceSideEffect,
  hookExecutor: HookExecutor | undefined,
  events: EventEmitter | undefined,
  outboxId?: string,
  triggers?: ResourceTriggerDispatch
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
  // Awaited rather than emitted, so a Trigger that fails to start its Run fails the delivery and
  // the outbox retries it. The in-process emit above cannot do that: its subscribers are
  // fire-and-forget, which is correct for indexing and wrong for minting a Run.
  if (triggers && outboxId !== undefined) {
    await triggers.dispatchResourceMutation(effect, outboxId);
  }
}

export async function startDelivery(
  database: Queryable,
  hookExecutor: HookExecutor | undefined,
  events: EventEmitter,
  log: { error(message: string): void },
  triggers?: ResourceTriggerDispatch
): Promise<() => void> {
  const dispatcher = new ResourceSideEffectDispatcher(
    new ResourceSideEffectOutbox(database),
    `api.resource-side-effects.${process.pid}`,
    (effect, id) => deliverResourceSideEffect(effect, hookExecutor, events, id, triggers)
  );
  const report = (error: unknown) =>
    log.error(
      `Resource side-effect drain failed — ${error instanceof Error ? error.message : String(error)}`
    );
  await dispatcher.dispatchBatch().catch(report);
  let draining = false;
  const interval = setInterval(() => {
    if (draining) return;
    draining = true;
    void dispatcher
      .dispatchBatch()
      .catch(report)
      .finally(() => {
        draining = false;
      });
  }, 1_000);
  interval.unref?.();
  return () => clearInterval(interval);
}

export function resourceSideEffectMigration(
  apply: (statements: readonly string[]) => (database: Queryable) => Promise<void>
): { version: number; description: string; up: (database: Queryable) => Promise<void> } {
  return {
    version: 78,
    description: "resources: durable mutation delivery and idempotent Record creation",
    up: apply(RESOURCE_SIDE_EFFECT_STORAGE_STATEMENTS),
  };
}
