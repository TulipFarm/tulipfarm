import { describe, expect, it } from "vitest";
import type { IdentityPort, IdentityResolution } from "./identity";

describe("IdentityPort", () => {
  it("resolves an external subject without exposing provider credentials", async () => {
    const expected: IdentityResolution = {
      principalId: "user-1",
      principalKind: "user",
      externalSubject: "subject-1",
      provider: "oidc",
    };
    const port: IdentityPort = {
      resolve: async () => expected,
    };

    await expect(
      port.resolve({ provider: "oidc", externalSubject: "subject-1", businessId: "business-1" })
    ).resolves.toEqual(expected);
  });
});
