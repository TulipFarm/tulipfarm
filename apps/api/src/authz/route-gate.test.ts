import type { AuthorityLayer } from "@tulipfarm/authz";
import { DEPLOYMENT_BUSINESS_ID } from "@tulipfarm/constants";
import type { FastifyReply, FastifyRequest } from "fastify";
import { describe, expect, it } from "vitest";
import type { AuthorityPrincipal } from "../identity/authority-layers";
import type { RequestPrincipal } from "../identity/principal";
import {
  type AuthorizationDivergence,
  deploymentGateOptions,
  LiveRouteAuthorizer,
  makeAuthorizationCheck,
  makeRequireAuthorization,
  type RouteAuthorization,
  type RouteAuthorizer,
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

  it("carries an exact record id into Secret metadata decisions", async () => {
    const check = makeAuthorizationCheck(
      new LiveRouteAuthorizer(
        resolverOf([
          {
            action: "secret.read",
            resourceType: "secret",
            recordSelector: "VISIBLE_TOKEN",
            effect: "allow",
          },
        ])
      )
    );
    await expect(
      check(principal("member"), {
        action: "secret.read",
        resourceType: "secret",
        recordId: "VISIBLE_TOKEN",
        fallback: "admin",
      })
    ).resolves.toBe(true);
    await expect(
      check(principal("member"), {
        action: "secret.read",
        resourceType: "secret",
        recordId: "HIDDEN_TOKEN",
        fallback: "admin",
      })
    ).resolves.toBe(false);
  });
});

/**
 * `authorization-design.md` §5 step 2. The value of shadow mode is entirely in the pair of
 * properties below: it must change no answer, and it must still produce the evidence. A shadow
 * mode that quietly denies is an outage; one that observes nothing is a no-op with a flag.
 */
describe("route gate shadow mode", () => {
  const DENY_ALL = new LiveRouteAuthorizer(resolverOf([]));
  const ALLOW_ALL = new LiveRouteAuthorizer(
    resolverOf([{ action: "*", resourceType: "*", effect: "allow" as const }])
  );

  it("serves the fallback, not the engine, when the engine would deny", async () => {
    const gate = makeRequireAuthorization(DENY_ALL, { mode: "shadow" });
    const { reply, sent } = replyDouble();
    await gate(READ)(request(principal("admin")), reply);
    expect(sent.code).toBeUndefined();
  });

  it("still refuses what the fallback refuses, even where the engine would allow", async () => {
    const gate = makeRequireAuthorization(ALLOW_ALL, { mode: "shadow" });
    const { reply, sent } = replyDouble();
    await gate(READ)(request(principal("member")), reply);
    expect(sent.code).toBe(403);
  });

  it("reports the would-deny that enforcing the engine today would have caused", async () => {
    const seen: AuthorizationDivergence[] = [];
    const gate = makeRequireAuthorization(DENY_ALL, {
      mode: "shadow",
      observe: (d) => seen.push(d),
    });
    await gate(READ)(request(principal("admin")), replyDouble().reply);
    expect(seen).toEqual([
      {
        mode: "shadow",
        action: "llm_config.read",
        resourceType: "llm_config",
        principalKind: "user",
        principalId: "u1",
        fallback: "admin",
        fallbackAllowed: true,
        engineAllowed: false,
      },
    ]);
  });

  it("stays silent when the engine and the fallback agree", async () => {
    const seen: AuthorizationDivergence[] = [];
    const gate = makeRequireAuthorization(ALLOW_ALL, {
      mode: "shadow",
      observe: (d) => seen.push(d),
    });
    await gate(READ)(request(principal("admin")), replyDouble().reply);
    expect(seen).toEqual([]);
  });

  /* ADR-009: a grant may narrow a route, never widen it. Enforcing mode is where that shows up. */
  it("reports a would-allow under enforcement, where a grant is wider than the check it replaced", async () => {
    const seen: AuthorizationDivergence[] = [];
    const gate = makeRequireAuthorization(ALLOW_ALL, { observe: (d) => seen.push(d) });
    await gate(READ)(request(principal("member")), replyDouble().reply);
    expect(seen).toMatchObject([
      { mode: "enforcing", fallbackAllowed: false, engineAllowed: true },
    ]);
  });

  it("enforces by default, so an omitted mode can never silently stop denying", async () => {
    const gate = makeRequireAuthorization(DENY_ALL, { observe: () => {} });
    const { reply, sent } = replyDouble();
    await gate(READ)(request(principal("admin")), reply);
    expect(sent.code).toBe(403);
  });

  it("observes nothing without an authorizer, since one decision cannot diverge from itself", async () => {
    const seen: AuthorizationDivergence[] = [];
    const gate = makeRequireAuthorization(undefined, {
      mode: "shadow",
      observe: (d) => seen.push(d),
    });
    await gate(READ)(request(principal("member")), replyDouble().reply);
    expect(seen).toEqual([]);
  });

  it("refuses an unauthenticated request in shadow mode too", async () => {
    const gate = makeRequireAuthorization(DENY_ALL, { mode: "shadow" });
    const { reply, sent } = replyDouble();
    return gate(READ)(request(), reply).then(() => {
      expect(sent.code).toBe(401);
    });
  });

  /**
   * The one way a shadow rehearsal could still take a deployment down: an engine
   * that cannot answer at all. Observing must not be able to fail the request it
   * is only observing — but enforcing must still refuse, because there a missing
   * answer is the absence of a grant.
   */
  describe("an engine that throws", () => {
    const BROKEN: RouteAuthorizer = {
      authorize: async () => {
        throw new Error("grant store unreachable");
      },
    };

    it("serves the fallback and records the failure in shadow mode", async () => {
      const seen: AuthorizationDivergence[] = [];
      const check = makeAuthorizationCheck(BROKEN, {
        mode: "shadow",
        observe: (d) => seen.push(d),
      });
      await expect(check(principal("admin"), READ)).resolves.toBe(true);
      expect(seen).toEqual([
        expect.objectContaining({ engineAllowed: "threw", error: "grant store unreachable" }),
      ]);
    });

    it("propagates in enforcing mode so the request fails closed", async () => {
      const check = makeAuthorizationCheck(BROKEN, { mode: "enforcing" });
      await expect(check(principal("admin"), READ)).rejects.toThrow("grant store unreachable");
    });
  });

  describe("deployment wiring", () => {
    const noop = () => ({ warn: () => {} });

    it("enforces when AUTHZ_MODE is unset", () => {
      expect(deploymentGateOptions(noop, {}).mode).toBe("enforcing");
    });

    it("shadows only on the exact opt-out value", () => {
      expect(deploymentGateOptions(noop, { AUTHZ_MODE: "shadow" }).mode).toBe("shadow");
      expect(deploymentGateOptions(noop, { AUTHZ_MODE: "Shadow" }).mode).toBe("enforcing");
      expect(deploymentGateOptions(noop, { AUTHZ_MODE: "" }).mode).toBe("enforcing");
    });

    it("logs a divergence under a stable event name", () => {
      const lines: Array<{ payload: object; message: string }> = [];
      const options = deploymentGateOptions(
        () => ({ warn: (payload, message) => lines.push({ payload, message }) }),
        { AUTHZ_MODE: "shadow" }
      );
      options.observe?.({
        mode: "shadow",
        action: "llm_config.read",
        resourceType: "llm_config",
        principalKind: "user",
        principalId: "u1",
        fallback: "admin",
        fallbackAllowed: true,
        engineAllowed: false,
      });
      expect(lines).toHaveLength(1);
      expect(lines[0]?.payload).toMatchObject({
        event: "authz.divergence",
        action: "llm_config.read",
        engineAllowed: false,
      });
    });

    /* The logger is read per call, because the gate is built before Fastify exists. */
    it("resolves the logger at divergence time, not at construction", () => {
      let ready = false;
      const options = deploymentGateOptions(() => {
        if (!ready) throw new Error("logger read too early");
        return { warn: () => {} };
      }, {});
      ready = true;
      expect(() =>
        options.observe?.({
          mode: "enforcing",
          action: "a",
          resourceType: "r",
          principalKind: "user",
          principalId: "u1",
          fallback: "admin",
          fallbackAllowed: false,
          engineAllowed: true,
        })
      ).not.toThrow();
    });
  });
});
