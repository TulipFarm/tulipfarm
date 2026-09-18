import { decideEffectivePermission } from "@tulipfarm/authz";
import Fastify from "fastify";
import { expect, it } from "vitest";
import type { RouteAuthorization } from "../../authz/route-gate";
import { DEPLOYMENT_ROLES } from "../../identity/roles";
import { registerMcpKnowledgeRoutes } from "./routes";

it("uses the member account surface for MCP Knowledge account operations", async () => {
  const app = Fastify();
  const authorizations: RouteAuthorization[] = [];
  registerMcpKnowledgeRoutes(
    app,
    { knowledge: {} as never, readerUserId: async () => "user-1" },
    async () => {},
    (authorization) => {
      authorizations.push(authorization);
      return async () => {};
    }
  );
  try {
    await app.ready();
    const member = DEPLOYMENT_ROLES.find((role) => role.id === "member");
    if (!member) throw new Error("Missing member role");
    expect(
      authorizations.filter(({ action }) => action.startsWith("integration.accounts."))
    ).toEqual([
      {
        action: "integration.accounts.write",
        resourceType: "integration_account",
        fallback: "authenticated",
      },
      {
        action: "integration.accounts.read",
        resourceType: "integration_account",
        fallback: "authenticated",
      },
    ]);
    for (const { action, resourceType } of authorizations) {
      expect(
        decideEffectivePermission([{ name: "member", grants: member.grants }], {
          action,
          resourceType,
        }).allowed
      ).toBe(true);
    }
  } finally {
    await app.close();
  }
});
