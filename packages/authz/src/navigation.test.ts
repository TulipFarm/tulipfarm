import { expect, test } from "vitest";
import { sessionNavigationCapabilities } from "./navigation";

test("navigation capabilities omit every path whose authority is denied", async () => {
  const denied = new Set(["operations.read", "soul.git_config.read", "llm_config.read"]);
  const capabilities = await sessionNavigationCapabilities(
    "u1",
    async (_principal, authorization) => Promise.resolve(!denied.has(authorization.action))
  );

  expect(capabilities.visiblePaths).toEqual(
    expect.not.arrayContaining(["/inbox", "/business/soul", "/business/models"])
  );
  expect(capabilities.visiblePaths).toContain("/business/activities");
});
