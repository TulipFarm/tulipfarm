import type { UserAdminRepo } from "../auth/users";
import type { OimUserOffboarding } from "./oim-user-offboarding";

export const OIM_USER_OFFBOARDING_INTERVAL_MS = 60_000;

export interface OimUserOffboardingReconcileDeps {
  readonly users: Pick<UserAdminRepo, "listAll">;
  readonly offboarding: Pick<OimUserOffboarding, "disableUser">;
}

function failuresFrom(results: readonly PromiseSettledResult<unknown>[]): unknown[] {
  return results.flatMap((result) => {
    if (result.status === "fulfilled") return [];
    return result.reason instanceof AggregateError ? [...result.reason.errors] : [result.reason];
  });
}

/** Replays cleanup from durable disabled-user state and keeps every failure for the next sweep. */
export async function reconcileDisabledUsers(deps: OimUserOffboardingReconcileDeps): Promise<void> {
  const disabled = (await deps.users.listAll()).filter((user) => user.status === "disabled");
  const results = await Promise.allSettled(
    disabled.map((user) => deps.offboarding.disableUser(user._id))
  );
  const failures = failuresFrom(results);
  if (failures.length > 0) {
    throw new AggregateError(failures, "disabled-user offboarding reconciliation failed");
  }
}

export class OimUserOffboardingReconciler {
  #timer: ReturnType<typeof setInterval> | undefined;
  #running: Promise<void> | undefined;

  constructor(
    private readonly deps: OimUserOffboardingReconcileDeps,
    private readonly log: { error(message: string): void },
    private readonly intervalMs = OIM_USER_OFFBOARDING_INTERVAL_MS
  ) {}

  start(): void {
    if (this.#timer !== undefined) return;
    void this.#tick();
    this.#timer = setInterval(() => void this.#tick(), this.intervalMs);
    this.#timer.unref();
  }

  async stop(): Promise<void> {
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
    await this.#running;
  }

  runOnce(): Promise<void> {
    return reconcileDisabledUsers(this.deps);
  }

  async #tick(): Promise<void> {
    if (this.#running !== undefined) return;
    this.#running = this.runOnce()
      .catch((error) => {
        const failures = error instanceof AggregateError ? error.errors : [error];
        for (const failure of failures) {
          this.log.error(
            `[oim-user-offboarding] ${failure instanceof Error ? failure.message : String(failure)}`
          );
        }
      })
      .finally(() => {
        this.#running = undefined;
      });
    await this.#running;
  }
}
