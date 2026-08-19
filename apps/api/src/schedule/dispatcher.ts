import { planSchedule, ScheduleError, scheduleSpecFromTrigger } from "@tulipfarm/run-kernel";
import { definitions } from "@tulipfarm/schema";
import type { RuntimeBundle } from "@tulipfarm/soul";
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
  }) => Promise<{ readonly runId: string; readonly outcome: "started" | "duplicate" }>;
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
    const { activeBundle, stateStore, startRoutine, businessId, log } = this.deps;
    const nowMs = this.now();

    const existingRows = await stateStore.listForBusiness(businessId);
    const existingByKey = new Map(
      existingRows.map((row) => [`${row.routineSlug}:${row.triggerIndex}`, row])
    );

    const liveTriggers: Array<{ routineSlug: string; triggerIndex: number }> = [];
    const bundle = await activeBundle();
    const triggerIndexByRoutine = new Map<string, number>();

    for (const definition of bundle?.definitions ?? []) {
      if (definition.kind !== "Trigger") continue;
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

      let plan: ReturnType<typeof planSchedule>;
      try {
        plan = planSchedule(
          spec,
          { lastScheduledForMs: existing?.lastScheduledForMs ?? null, activeRuns: 0 },
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
      for (const fire of plan.fires) {
        try {
          await startRoutine({ slug, idempotencyKey: fire.deduplicationKey });
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
      });
    }

    await stateStore.pruneMissing(businessId, liveTriggers, existingRows);
  }
}
