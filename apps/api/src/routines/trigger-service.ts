import { randomUUID } from "node:crypto";
import type { EventEmitter } from "node:events";
import { ajv } from "@tulipfarm/schema";
import { DOMAIN_EVENTS } from "../domain-events";
import { definitionHash } from "./definition-hash";
import type { RoutineEnqueuers } from "./jobs";
import type { LoadedRoutine, RoutineRegistry } from "./registry";
import type { RoutineRunsRepo } from "./repo";

export type TriggerType = "event" | "manual" | "cron" | "webhook" | "agent";

export interface TriggerInvocation {
  type: TriggerType;
  payload?: unknown;
  triggerIndex?: number;
}

export interface PersistedRunTrigger {
  type: TriggerType;
  payload?: unknown;
  triggerIndex?: number;
}

export class RoutineTriggerError extends Error {
  constructor(
    readonly code: "not_found" | "trigger_not_declared" | "invalid_inputs" | "routine_invalid",
    message: string
  ) {
    super(message);
    this.name = "RoutineTriggerError";
  }
}

type TriggerLogger = {
  error: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
};

export interface TriggerServiceDeps {
  registry: RoutineRegistry;
  runs: RoutineRunsRepo;
  enqueuers: RoutineEnqueuers;
  /** Evaluates an event trigger's `filter` expression (isolated-vm). */
  evalFilter?: (code: string, scope: Record<string, unknown>) => Promise<unknown>;
  log: TriggerLogger;
}

/**
 * Single funnel for all five trigger types (D6/D8): validates the routine exists and
 * declares the trigger, AJV-validates the payload against `x-inputs` (manual, webhook
 * and agent alike — not per-route), creates the run row with the pinned
 * definitionSnapshot, and enqueues `routine-run`. This is also the seam v0.12
 * integration ingress plugs into (`emit_event` → domain event → event trigger).
 */
export class RoutineTriggerService {
  constructor(private readonly deps: TriggerServiceDeps) {}

  async trigger(slug: string, trigger: TriggerInvocation): Promise<{ runId: string }> {
    const { registry, runs, enqueuers } = this.deps;
    const entry = registry.getEntry(slug);
    if (!entry) throw new RoutineTriggerError("not_found", `routine "${slug}" not found`);
    if (!entry.ok) {
      throw new RoutineTriggerError(
        "routine_invalid",
        `routine "${slug}" failed validation: ${entry.loadError}`
      );
    }
    const triggerIndex = this.resolveTriggerIndex(entry, trigger);
    if (triggerIndex === null) {
      throw new RoutineTriggerError(
        "trigger_not_declared",
        `routine "${slug}" does not declare a "${trigger.type}" trigger`
      );
    }

    this.validateInputs(entry, trigger);

    const runId = randomUUID();
    const persistedTrigger: PersistedRunTrigger = {
      type: trigger.type,
      payload: trigger.payload,
      triggerIndex,
    };
    await runs.create({
      id: runId,
      routineSlug: slug,
      definitionSnapshot: entry.definition,
      definitionHash: definitionHash(entry.definition),
      currentState: entry.definition.start,
      context: this.initialContext(trigger),
      trigger: persistedTrigger,
    });
    await enqueuers.enqueueRun({
      runId,
      slug,
      trigger: persistedTrigger,
    });
    return { runId };
  }

  private resolveTriggerIndex(
    routine: LoadedRoutine,
    invocation: TriggerInvocation
  ): number | null {
    const triggers = routine.definition["x-triggers"];
    if (invocation.triggerIndex === undefined) {
      const index = triggers.findIndex((trigger) => trigger.type === invocation.type);
      return index >= 0 ? index : null;
    }

    const index = invocation.triggerIndex;
    if (!Number.isInteger(index) || index < 0 || index >= triggers.length) return null;
    return triggers[index]?.type === invocation.type ? index : null;
  }

  /** Trigger payloads that are plain objects seed the run's data-flow context. */
  private initialContext(trigger: { payload?: unknown }): Record<string, unknown> {
    const p = trigger.payload;
    return typeof p === "object" && p !== null && !Array.isArray(p)
      ? (p as Record<string, unknown>)
      : {};
  }

  private validateInputs(
    routine: LoadedRoutine,
    trigger: { type: TriggerType; payload?: unknown }
  ) {
    // x-inputs gates caller-supplied payloads; cron/event payloads are system-shaped.
    if (trigger.type !== "manual" && trigger.type !== "webhook" && trigger.type !== "agent") return;
    const schema = routine.definition["x-inputs"];
    if (!schema) return;
    const validate = ajv.compile(schema);
    if (!validate(trigger.payload ?? {})) {
      const e = validate.errors?.[0];
      throw new RoutineTriggerError(
        "invalid_inputs",
        `inputs${e?.instancePath ?? ""} ${e?.message ?? "are invalid"}`
      );
    }
  }
}

/**
 * Subscribes routine `event` triggers to the in-process domain-event bus. For every
 * emitted event, every valid routine declaring a matching event trigger is started
 * (optionally gated by the trigger's isolated-vm `filter` expression). In-process only
 * in V1 (single instance); LISTEN/NOTIFY is the flagged multi-instance upgrade.
 */
export function subscribeRoutineEventTriggers(
  events: EventEmitter,
  service: RoutineTriggerService,
  registry: RoutineRegistry,
  evalFilter: ((code: string, scope: Record<string, unknown>) => Promise<unknown>) | undefined,
  log: TriggerLogger
): void {
  for (const eventName of Object.values(DOMAIN_EVENTS)) {
    events.on(eventName, (payload: unknown) => {
      void (async () => {
        for (const routine of registry.valid()) {
          for (const [triggerIndex, trigger] of routine.definition["x-triggers"].entries()) {
            if (trigger.type !== "event" || trigger.event !== eventName) continue;
            try {
              if (trigger.filter && evalFilter) {
                const pass = await evalFilter(trigger.filter, {
                  trigger: { type: "event", event: eventName, payload },
                });
                if (!pass) continue;
              }
              await service.trigger(routine.slug, { type: "event", payload, triggerIndex });
            } catch (err) {
              log.error(
                { err, slug: routine.slug, event: eventName },
                "event-triggered routine failed to start"
              );
            }
          }
        }
      })();
    });
  }
}
