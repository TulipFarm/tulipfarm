import type { InternalApiClient } from "../internal/client";

export type RoutineOwnerStatus =
  | {
      readonly status: "allowed";
      readonly ownership: "personal" | "organization" | "team";
    }
  | {
      readonly status: "denied";
      readonly reason: "personal_owner_disabled" | "personal_owner_missing";
    }
  | { readonly status: "unavailable" };

export interface RoutineOwnerGuard {
  check(input: { readonly runId: string }): Promise<RoutineOwnerStatus>;
}

/** Reads trusted ownership from the API, which re-derives it from the Run and durable projection. */
export class HttpRoutineOwnerGuard implements RoutineOwnerGuard {
  constructor(private readonly client: InternalApiClient) {}

  check(input: { readonly runId: string }): Promise<RoutineOwnerStatus> {
    return this.client.require<RoutineOwnerStatus>(
      "GET",
      `/api/v1/internal/runs/${encodeURIComponent(input.runId)}/routine-owner-status`
    );
  }
}
