import { describe, expect, it } from "vitest";
import type { TeamApiServiceDeps } from "./team-service";
import { TeamApiService } from "./team-service";

const baseDeps = {
  teams: {},
  principals: {},
  roles: {},
  explanations: {},
} as unknown as TeamApiServiceDeps;

describe("TeamApiService construction", () => {
  it("rejects a missing move asset impact adapter", () => {
    expect(
      () =>
        new TeamApiService({
          ...baseDeps,
          moveAssets: undefined,
        } as unknown as TeamApiServiceDeps)
    ).toThrow(/move asset impact adapter/);
  });
});
