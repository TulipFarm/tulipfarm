import { describe, expect, it } from "vitest";
import { decideEffectivePermission } from "./effective";
import type { AccessGrant } from "./grants";
import {
  narrowOperationalGrants,
  OPERATIONAL_UPDATE_READ,
  operationalScopeMatches,
  operationalUpdateRequest,
} from "./operational";

const scope = { businessId: "business-1", installationId: "installation-1" };
const allow: AccessGrant = {
  ...OPERATIONAL_UPDATE_READ,
  conditions: scope,
  effect: "allow",
};

describe("operational credential ceiling", () => {
  it("requires exact action, resource, business and installation grants", () => {
    for (const grant of [
      { ...allow, action: "*" },
      { ...allow, resourceType: "*" },
      { ...allow, conditions: undefined },
      { ...allow, conditions: { ...scope, businessId: "other" } },
      { ...allow, conditions: { ...scope, installationId: "other" } },
      { ...allow, action: "record.read" },
    ]) {
      expect(narrowOperationalGrants([grant], scope)).toEqual([]);
    }
    expect(narrowOperationalGrants([allow], scope)).toEqual([allow]);
  });

  it("preserves deny wins, expiry, and every layer of the intersection", () => {
    const request = operationalUpdateRequest(scope);
    const layer = { name: "service", grants: narrowOperationalGrants([allow], scope) };
    expect(decideEffectivePermission([layer], request).allowed).toBe(true);
    expect(decideEffectivePermission([layer, { name: "agent", grants: [] }], request).allowed).toBe(
      false
    );
    expect(
      decideEffectivePermission(
        [
          {
            name: "service",
            grants: narrowOperationalGrants(
              [allow, { action: "*", resourceType: "*", effect: "deny" }],
              scope
            ),
          },
        ],
        request
      ).allowed
    ).toBe(false);
    expect(
      decideEffectivePermission(
        [{ name: "service", grants: [{ ...allow, expiresAt: new Date(0) }] }],
        request
      ).allowed
    ).toBe(false);
  });

  it("never treats a hosting flag or missing runtime identity as a binding", () => {
    expect(operationalScopeMatches(scope, undefined)).toBe(false);
    expect(operationalScopeMatches(scope, { ...scope, businessId: "other" })).toBe(false);
    expect(operationalScopeMatches(scope, { ...scope, installationId: "other" })).toBe(false);
    expect(operationalScopeMatches(scope, scope)).toBe(true);
  });
});
