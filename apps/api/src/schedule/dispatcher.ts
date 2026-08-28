import { planSchedule, ScheduleError, scheduleSpecFromTrigger } from "@tulipfarm/run-kernel";
import { definitions } from "@tulipfarm/schema";
import { bundleTriggerDefinitions, type RuntimeBundle } from "@tulipfarm/soul";
import type { RoutineScheduleStateStore } from "./state-store";

export interface ScheduleDispatcherLogger {
  warn(message: string, error?: unknown): void;
  error(message: string, error?: unknown): void;
}

export interface ScheduleDispatcherDeps {
  /** Schedules only execute from the same verified publication the runtime resolves. */
  readonly activeBundle: () => Promise<RuntimeBundle | undefined>;
  readonly stateStore: RoutineScheduleStateStore;
  readonly startRoutine: (input: {
    readonly slug: string;
    readonly idempotencyKey: string;
    /** The Trigger's authored background identity — the Run's effective subject. */
    readonly identity: { readonly kind: string; readonly id: string };
  }) => Promise<{ readonly runId: string; readonly outcome: "started" | "duplicate" }>;
  /**
   * Unfinished Runs of this Routine. `overlapPolicy` is only meaningful against a live count, and
   * a dispatcher that cannot obtain one must not silently behave as `allow`.
   */
  readonly countActiveRuns: (input: {
    readonly routineId: string;
    readonly routineSlug: string;
  }) => Promise<number>;
  /**
   * Stop the Runs a superseding occurrence replaces.
   *
   * `overlapPolicy: "supersede"` means the newest occurrence takes over from the running one.
   * Without this the dispatcher starts the replacement and leaves the replaced Run going, which is
   * `allow` wearing another name — and the author asked for one Run, not two.
   */
  readonly supersedeActiveRuns?: (input: {
    readonly routineId: string;
    readonly routineSlug: string;
  }) => Promise<void>;
  readonly businessId: string;
  readonly now?: () => number;
  readonly log?: ScheduleDispatcherLogger;
}

/** API-owned Routine schedule ticker reads published Trigger definitions and starts due Runs idempotently. */
export class ScheduleDispatcher {
  private readonly now: () => number;

  constructor(private readonly deps: ScheduleDispatcherDeps) {
    this.now = deps.now ?? (() => Date.now());
  }

  async tick(): Promise<void> {
    const {
      activeBundle,
      stateStore,
      startRoutine,
      countActiveRuns,
      supersedeActiveRuns,
      businessId,
      log,
    } = this.deps;
    const nowMs = this.now();

    const existingRows = await stateStore.listForBusiness(businessId);
    const existingByKey = new Map(
      existingRows.map((row) => [`${row.routineSlug}:${row.triggerIndex}`, row])
    );

    const liveTriggers: Array<{ routineSlug: string; triggerIndex: number }> = [];
    const bundle = await activeBundle();
    const triggerIndexByRoutine = new Map<string, number>();

    for (const definition of bundleTriggerDefinitions(bundle)) {
      let trigger: definitions.trigger.TriggerDefinition;
      try {
        trigger = definitions.trigger.validateTriggerDefinition(definition.document).document;
      } catch {
        continue;
      }
      if (trigger.metadata.lifecycle !== "published") continue;
      const slug = trigger.spec.routineRef.name;
      const triggerIndex = triggerIndexByRoutine.get(slug) ?? 0;
      triggerIndexByRoutine.set(slug, triggerIndex + 1);
      let spec: ReturnType<typeof scheduleSpecFromTrigger>;
      try {
        spec = scheduleSpecFromTrigger(trigger);
      } catch (error) {
        if (error instanceof ScheduleError && error.code === "not_a_schedule") continue;
        throw error;
      }
      liveTriggers.push({ routineSlug: slug, triggerIndex });
      const existing = existingByKey.get(`${slug}:${triggerIndex}`);

      // Runs pin `bundle.routineId`, not the slug, so counting this Routine's active Runs needs
      // the published Routine's identity. A Trigger naming a Routine this publication does not
      // carry could not start one either, so skip it rather than plan against an unknown target.
      const routineId = bundle?.get("Routine", slug)?.id;
      if (routineId === undefined) {
        log?.warn(
          `schedule dispatcher: trigger ${slug}:${triggerIndex} names no published Routine`
        );
        continue;
      }

      // An `interval` Trigger authored without `schedule.startAt` has no phase origin, and
      // `planSchedule` refuses it. Anchor it once, on first sight, and persist that instant so
      // every later tick enumerates from the same origin — recomputing it per tick would push the
      // next occurrence forward forever and the Routine would never run.
      const anchorMs =
        spec.type === "interval" && spec.startAt === undefined
          ? (existing?.anchorMs ?? nowMs)
          : null;
      const anchored =
        anchorMs === null ? spec : { ...spec, startAt: new Date(anchorMs).toISOString() };

      let plan: ReturnType<typeof planSchedule>;
      try {
        plan = planSchedule(
          anchored,
          {
            lastScheduledForMs: existing?.lastScheduledForMs ?? null,
            activeRuns: await countActiveRuns({ routineId, routineSlug: slug }),
          },
          nowMs
        );
      } catch (error) {
        if (error instanceof ScheduleError) {
          log?.warn(`schedule dispatcher: invalid trigger ${slug}:${triggerIndex}`, error);
          continue;
        }
        throw error;
      }

      // Only a fire that actually started may advance the watermark — otherwise a transient
      // startRoutine failure would be recorded as delivered and, under the default 'skip'
      // missedRunPolicy, never reconsidered on a later tick.
      let lastScheduledForMs = existing?.lastScheduledForMs ?? null;
      if (plan.skipped > 0) {
        log?.warn(
          `schedule dispatcher: ${slug}:${triggerIndex} skipped ${plan.skipped} occurrence(s) ` +
            `under ${spec.overlapPolicy}/${spec.missedRunPolicy}`
        );
      }
      for (const fire of plan.fires) {
        try {
          // Cancel before starting: the replacement must not run alongside what it replaces, and
          // a failure here must stop the fire rather than produce the overlap `supersede` forbids.
          if (fire.supersede && supersedeActiveRuns) {
            await supersedeActiveRuns({ routineId, routineSlug: slug });
          }
          await startRoutine({
            slug,
            idempotencyKey: fire.deduplicationKey,
            identity: {
              kind: trigger.spec.backgroundIdentity.principalKind,
              id: trigger.spec.backgroundIdentity.principalId,
            },
          });
          lastScheduledForMs = fire.scheduledForMs;
        } catch (error) {
          log?.error(`schedule dispatcher: failed to start ${slug}:${triggerIndex}`, error);
          break;
        }
      }

      await stateStore.upsert(businessId, {
        routineSlug: slug,
        triggerIndex,
        dedupKey: spec.deduplicationKey,
        lastScheduledForMs,
        nextDueAtMs: plan.nextDueAtMs,
        anchorMs,
      });
    }

    await stateStore.pruneMissing(businessId, liveTriggers, existingRows);
  }
}
