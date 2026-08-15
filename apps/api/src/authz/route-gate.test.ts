import type { AuthorityLayer } from "@tulipfarm/authz";
import { DEPLOYMENT_BUSINESS_ID } from "@tulipfarm/constants";
import type { FastifyReply, FastifyRequest } from "fastify";
import { describe, expect, it } from "vitest";
import type { AuthorityPrincipal } from "../identity/authority-layers";
import type { RequestPrincipal } from "../identity/principal";
import {
  LiveRouteAuthorizer,
  makeRequireAuthorization,
  type RouteAuthorization,
} from "./route-gate";

const READ: RouteAuthorization = {
  action: "llm_config.read",
  resourceType: "llm_config",
  fallback: "admin",
};

const MEMBER_SURFACE: RouteAuthorization = {
  action: "chat.read",
  resourceType: "chat",
  fallback: "authenticated",
};

function principal(role: RequestPrincipal["role"], kind: RequestPrincipal["kind"] = "user") {
  return {
    id: "u1",
    kind,
    businessId: DEPLOYMENT_BUSINESS_ID,
    credential: "session",
    authMethods: [],
    authenticatedAt: new Date(),
    ...(role === undefined ? {} : { role }),
  } satisfies RequestPrincipal;
}

interface Sent {
  code?: number;
  body?: unknown;
}

function replyDouble(): { reply: FastifyReply; sent: Sent } {
  const sent: Sent = {};
  const reply = {
    code(status: number) {
      sent.code = status;
      return this;
    },
    async send(body: unknown) {
      sent.body = body;
    },
  } as unknown as FastifyReply;
  return { reply, sent };
}

function request(p?: RequestPrincipal): FastifyRequest {
  return { principal: p } as unknown as FastifyRequest;
}

/** A resolver returning one fixed layer, standing in for live principal and role rows. */
function resolverOf(grants: AuthorityLayer["grants"]) {
  return {
    async resolvePrincipalLayer(name: string, _p: AuthorityPrincipal): Promise<AuthorityLayer> {
      return { name, grants };
    },
  };
}

describe("route gate", () => {
  it("refuses an unauthenticated request with 401 before any decision", async () => {
    const gate = makeRequireAuthorization(new LiveRouteAuthorizer(resolverOf([])));
    const { reply, sent } = replyDouble();
    await gate(READ)(request(), reply);
    expect(sent.code).toBe(401);
  });

  it("allows a caller whose live layer grants the declared action", async () => {
    const gate = makeRequireAuthorization(
      new LiveRouteAuthorizer(
        resolverOf([{ action: "*", resourceType: "*", effect: "allow" as const }])
      )
    );
    const { reply, sent } = replyDouble();
    await gate(READ)(request(principal("admin")), reply);
    expect(sent.code).toBeUndefined();
  });

  it("refuses a caller whose live layer denies the declared action, whatever their role", async () => {
    const gate = makeRequireAuthorization(
      new LiveRouteAuthorizer(
        resolverOf([
          { action: "*", resourceType: "*", effect: "allow" as const },
          { action: "llm_config.read", resourceType: "llm_config", effect: "deny" as const },
        ])
      )
    );
    const { reply, sent } = replyDouble();
    await gate(READ)(request(principal("admin")), reply);
    expect(sent.code).toBe(403);
    expect(sent.body).toEqual({ error: "forbidden" });
  });

  it("refuses a caller with no grants at all, rather than defaulting to their role", async () => {
    const gate = makeRequireAuthorization(new LiveRouteAuthorizer(resolverOf([])));
    const { reply, sent } = replyDouble();
    await gate(READ)(request(principal("admin")), reply);
    expect(sent.code).toBe(403);
  });

  /* An unwired authorizer must never widen a route: absence falls back to the declaration. */
  it("falls back to the declared admin check when no authorizer is wired", async () => {
    const gate = makeRequireAuthorization(undefined);
    const denied = replyDouble();
    await gate(READ)(request(principal("member")), denied.reply);
    expect(denied.sent.code).toBe(403);

    const allowed = replyDouble();
    await gate(READ)(request(principal("admin")), allowed.reply);
    expect(allowed.sent.code).toBeUndefined();
  });

  it("treats a service principal as non-admin under the fallback, since it holds no role", async () => {
    const gate = makeRequireAuthorization(undefined);
    const { reply, sent } = replyDouble();
    await gate(READ)(request(principal(undefined, "service")), reply);
    expect(sent.code).toBe(403);
  });

  it("lets an authenticated-fallback route through without an authorizer", async () => {
    const gate = makeRequireAuthorization(undefined);
    const { reply, sent } = replyDouble();
    await gate(MEMBER_SURFACE)(request(principal("member")), reply);
    expect(sent.code).toBeUndefined();
  });

  it("still refuses an authenticated-fallback route when the live layer denies it", async () => {
    const gate = makeRequireAuthorization(new LiveRouteAuthorizer(resolverOf([])));
    const { reply, sent } = replyDouble();
    await gate(MEMBER_SURFACE)(request(principal("member")), reply);
    expect(sent.code).toBe(403);
  });

  it("carries the declared domain into the decision so a domainless grant cannot cross it", async () => {
    const gate = makeRequireAuthorization(
      new LiveRouteAuthorizer(
        resolverOf([{ action: "*", resourceType: "*", effect: "allow" as const }])
      )
    );
    const { reply, sent } = replyDouble();
    await gate({ ...READ, domain: "hr" })(request(principal("admin")), reply);
    expect(sent.code).toBe(403);
  });
});
