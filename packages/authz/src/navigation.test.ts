import { expect, test, vi } from "vitest";
import {
  NAVIGATION_REQUIREMENTS,
  type NavigationAuthorization,
  sessionNavigationCapabilities,
} from "./navigation";

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
  expect(capabilities.visiblePaths).toContain("/files");
});

test("secret.read declares the same fallback everywhere it gates navigation (#754)", () => {
  const secretReadFallbacks = NAVIGATION_REQUIREMENTS.flatMap((requirement) =>
    requirement.authorizations.filter((authorization) => authorization.action === "secret.read")
  ).map((authorization) => authorization.fallback);

  expect(secretReadFallbacks.length).toBeGreaterThan(0);
  // `secret.read` is enforced as admin-only everywhere else (apps/api/src/secrets/routes.ts); a
  // looser "authenticated" fallback here diverges from the engine under enforcing mode and, in
  // shadow mode or with no authorizer wired, would serve the permissive answer for real.
  for (const fallback of secretReadFallbacks) {
    expect(fallback).toBe("admin");
  }
});

test("navigation capabilities evaluate each repeated authorization once", async () => {
  const check = vi.fn(async (_principal: string, _authorization: NavigationAuthorization) => true);

  await sessionNavigationCapabilities("u1", check);

  const evaluated = check.mock.calls.map(
    ([, authorization]) => `${authorization.action}:${authorization.resourceType}`
  );
  expect(evaluated).toHaveLength(new Set(evaluated).size);
});
