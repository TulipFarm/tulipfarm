import type { AuthorityLayer, Role } from "@tulipfarm/authz";
import { DEPLOYMENT_BUSINESS_ID } from "@tulipfarm/constants";
import type { SoulLoader, SoulResource } from "@tulipfarm/soul";
import { describe, expect, it } from "vitest";
import type { AuthorityPrincipal } from "../identity/authority-layers";
import { DEPLOYMENT_ROLES } from "../identity/roles";
import { LiveRecordAuthorizer, recordTargets } from "./authorize";

/**
 * These tests run the **real** `DEPLOYMENT_ROLES` grants through the **real** decision function.
 * A fake layer would prove only that the plumbing calls something; the property that matters is
 * that the REST door reaches the same verdict the Tool door does for the same principal, and only
 * the shipped grants can show that.
 */

function loaderWith(resources: readonly SoulResource[]): SoulLoader {
  return { resources: new Map(resources.map((r) => [r.name, r])) } as unknown as SoulLoader;
}

function resource(name: string, domain?: string): SoulResource {
  return {
    name,
    schema: { type: "object" },
    hasHooks: false,
    hooksEnabled: true,
    ...(domain === undefined ? {} : { domain }),
  } as SoulResource;
}

/** A resolver returning the grants of one shipped Role, as the live resolver would compile them. */
function resolverForRole(roleId: string) {
  const role = DEPLOYMENT_ROLES.find((r: Role) => r.id === roleId);
  if (role === undefined) throw new Error(`no such deployment role: ${roleId}`);
  return {
    async resolvePrincipalLayer(name: string): Promise<AuthorityLayer> {
      return { name, grants: role.grants };
    },
  };
}

const CALLER: AuthorityPrincipal = {
  id: "user-1",
  businessId: DEPLOYMENT_BUSINESS_ID,
  kind: "user",
};

const LOADER = loaderWith([resource("ticket"), resource("salary_review", "hr")]);

describe("recordTargets", () => {
  it("derives the Resource-level target for a type-only request", () => {
    expect(recordTargets(LOADER, "ticket")).toEqual([{ type: "record", id: "ticket" }]);
  });

  it("adds the record-level target when an id is named", () => {
    expect(recordTargets(LOADER, "ticket", "r1")).toEqual([
      { type: "record", id: "ticket" },
      { type: "record.ticket", id: "r1" },
    ]);
  });

  it("carries the Resource's domain onto every target — the HR/engineering wall", () => {
    expect(recordTargets(LOADER, "salary_review", "r1")).toEqual([
      { type: "record", id: "salary_review", domain: "hr" },
      { type: "record.salary_review", id: "r1", domain: "hr" },
    ]);
  });

  it("leaves an unknown type undomained rather than guessing", () => {
    expect(recordTargets(LOADER, "nope", "r1")).toEqual([
      { type: "record", id: "nope" },
      { type: "record.nope", id: "r1" },
    ]);
  });
});

describe("LiveRecordAuthorizer", () => {
  const ACTIONS = [
    "record.create",
    "record.list",
    "record.read",
    "record.update",
    "record.delete",
  ] as const;

  it("lets a member reach an undomained Resource", async () => {
    const authorizer = new LiveRecordAuthorizer(LOADER, resolverForRole("member"));
    for (const action of ACTIONS) {
      expect(
        await authorizer.authorize({ principal: CALLER, action, type: "ticket", id: "r1" })
      ).toBe(true);
    }
  });

  it("refuses a member on a domained Resource — the same verdict the Tool path reaches", async () => {
    const authorizer = new LiveRecordAuthorizer(LOADER, resolverForRole("member"));
    for (const action of ACTIONS) {
      expect(
        await authorizer.authorize({ principal: CALLER, action, type: "salary_review", id: "r1" })
      ).toBe(false);
    }
  });

  it("refuses a member the type-level route too, not only the record-level one", async () => {
    const authorizer = new LiveRecordAuthorizer(LOADER, resolverForRole("member"));
    expect(
      await authorizer.authorize({
        principal: CALLER,
        action: "record.list",
        type: "salary_review",
      })
    ).toBe(false);
  });

  it("lets an admin reach a domained Resource — it carries a domain:* grant", async () => {
    const authorizer = new LiveRecordAuthorizer(LOADER, resolverForRole("admin"));
    for (const action of ACTIONS) {
      expect(
        await authorizer.authorize({ principal: CALLER, action, type: "salary_review", id: "r1" })
      ).toBe(true);
    }
  });

  it("refuses when the layer is empty — an unresolvable principal reaches nothing", async () => {
    const authorizer = new LiveRecordAuthorizer(LOADER, {
      async resolvePrincipalLayer(name: string): Promise<AuthorityLayer> {
        return { name, grants: [] };
      },
    });
    expect(
      await authorizer.authorize({
        principal: CALLER,
        action: "record.read",
        type: "ticket",
        id: "r1",
      })
    ).toBe(false);
  });
});
