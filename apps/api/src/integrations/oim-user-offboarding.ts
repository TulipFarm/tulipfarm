import type { PausePersonalRoutines } from "./oim-personal-routine-pause";

interface PersonalConnection {
  readonly id: string;
}

interface PersonalConnectionStore {
  listPersonalForPrincipal(
    businessId: string,
    principalId: string
  ): Promise<readonly PersonalConnection[]>;
  markRevoked(businessId: string, connectionId: string): Promise<boolean>;
}

export interface OimUserOffboardingDeps {
  readonly businessId: string;
  readonly connections: PersonalConnectionStore;
  readonly revokeConnectionLeases: (input: {
    businessId: string;
    connectionId: string;
  }) => Promise<void>;
  readonly pausePersonalRoutines: PausePersonalRoutines;
}

function failuresFrom(results: readonly PromiseSettledResult<unknown>[]): unknown[] {
  return results.flatMap((result) => {
    if (result.status === "fulfilled") return [];
    return result.reason instanceof AggregateError ? [...result.reason.errors] : [result.reason];
  });
}

/** Completes the retry-safe cleanup that follows a durable user disable. */
export class OimUserOffboarding {
  constructor(private readonly deps: OimUserOffboardingDeps) {}

  async disableUser(userId: string): Promise<void> {
    const results = await Promise.allSettled([
      this.offboardConnections(userId),
      this.deps.pausePersonalRoutines({ businessId: this.deps.businessId, userId }),
    ]);
    const failures = failuresFrom(results);
    if (failures.length > 0) {
      throw new AggregateError(failures, "user offboarding did not complete");
    }
  }

  private async offboardConnections(userId: string): Promise<void> {
    const connections = await this.deps.connections.listPersonalForPrincipal(
      this.deps.businessId,
      userId
    );
    const results = await Promise.allSettled(
      connections.flatMap((connection) => [
        this.deps.connections.markRevoked(this.deps.businessId, connection.id),
        this.deps.revokeConnectionLeases({
          businessId: this.deps.businessId,
          connectionId: connection.id,
        }),
      ])
    );
    const failures = failuresFrom(results);
    if (failures.length > 0) {
      throw new AggregateError(failures, "personal Connection offboarding did not complete");
    }
  }
}
