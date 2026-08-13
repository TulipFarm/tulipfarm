import { describe, expect, test } from "vitest";
import {
  accessAreas,
  actionFor,
  areaForResourceType,
  CHECKABLE_THINGS,
  CHECKABLE_VERBS,
  describeAction,
  describeGrant,
  describeResourceType,
  joinWords,
  roleTitle,
  summarizeRole,
  verbsFor,
} from "./access-language";
import type { AuthzGrant, AuthzRole } from "./authz";

function grant(overrides: Partial<AuthzGrant>): AuthzGrant {
  return {
    effect: "allow",
    action: "*",
    resourceType: "*",
    label: "allow any action on any resource",
    ...overrides,
  };
}

function role(overrides: Partial<AuthzRole>): AuthzRole {
  return {
    id: "support",
    source: "authored",
    displayName: null,
    slug: null,
    assignableTo: ["user"],
    parentRoleIds: [],
    grants: [],
    expiresAt: null,
    ...overrides,
  };
}

describe("describeResourceType", () => {
  test("names a record type rather than flattening it to 'records'", () => {
    // The whole point of a scoped grant is that HR records are not engineering records. A
    // rendering that collapsed `record.leave_request` to "Records" would tell an owner they had
    // granted the entire family.
    expect(describeResourceType("record.leave_request")).toBe("Leave request records");
    expect(describeResourceType("record.customer")).toBe("Customer records");
  });

  test("keeps the unqualified record family distinct from a single type", () => {
    expect(describeResourceType("record")).toBe("records");
  });

  test("uses the provider's own name for an integration", () => {
    expect(describeResourceType("integration.github")).toBe("the GitHub connection");
    expect(describeResourceType("integration.slack")).toBe("the Slack connection");
  });

  test("falls back to a provider slug it does not know rather than inventing one", () => {
    expect(describeResourceType("integration.acme_crm")).toBe("the Acme crm connection");
  });

  test("says 'everything' for the wildcard", () => {
    expect(describeResourceType("*")).toBe("everything");
  });

  /*
   * A resource type nobody mapped must still render, and it must render as *itself*. Folding an
   * unknown type into a friendly area would be the one failure mode that matters here: it would
   * claim an owner granted something narrower or broader than they did.
   */
  test("renders an unmapped resource type as its own name", () => {
    expect(describeResourceType("payroll_ledger")).toBe("payroll ledger");
  });
});

describe("describeAction", () => {
  test.each([
    ["record.read", "View"],
    ["record.list", "View"],
    ["record.search", "View"],
    ["record.create", "Add to"],
    ["record.update", "Change"],
    ["record.delete", "Remove from"],
    ["*", "Full access to"],
  ])("%s reads as %s", (action, expected) => {
    expect(describeAction(action)).toBe(expected);
  });

  test("humanizes a verb it has no wording for instead of dropping it", () => {
    expect(describeAction("soul.resource_type.set_domain")).toBe("Change");
    expect(describeAction("platform.thing.frobnicate")).toBe("Frobnicate");
  });
});

describe("describeGrant", () => {
  test("reads as a sentence about a business thing", () => {
    expect(describeGrant(grant({ action: "record.read", resourceType: "record.customer" }))).toBe(
      "View Customer records"
    );
  });

  /*
   * Effect is deliberately absent from the phrase. An allow and a deny that read alike would be
   * indistinguishable at list length, so the caller renders the effect as its own signal.
   */
  test("says nothing about allow or deny", () => {
    const allow = describeGrant(grant({ effect: "allow", action: "record.read" }));
    const deny = describeGrant(grant({ effect: "deny", action: "record.read" }));
    expect(allow).toBe(deny);
  });

  /*
   * Composing the verb literally gave "Full access to people and access", which reads as though
   * "access" belongs to the verb. An unrestricted action is a single English word instead.
   */
  test("an unrestricted action reads as one verb, not as a phrase glued to its object", () => {
    expect(describeGrant(grant({ action: "*", resourceType: "authz.role" }))).toBe(
      "Manage people and access"
    );
    expect(describeGrant(grant({ action: "*", resourceType: "record.customer" }))).toBe(
      "Manage Customer records"
    );
    expect(describeGrant(grant({ action: "*", resourceType: "*" }))).toBe("Do anything");
  });

  test("never leaks a dotted or underscored identifier for a known family", () => {
    const phrase = describeGrant(grant({ action: "*", resourceType: "authz.assignment" }));
    expect(phrase).not.toMatch(/[._]/);
  });
});

describe("summarizeRole", () => {
  test("marks a wildcard Role unrestricted, because no chip list can convey it", () => {
    const summary = summarizeRole(role({ id: "admin", grants: [grant({})] }));
    expect(summary.unrestricted).toBe(true);
  });

  test("collects the areas an authored Role reaches, without repeating one", () => {
    const summary = summarizeRole(
      role({
        grants: [
          grant({ action: "record.read", resourceType: "record.customer" }),
          grant({ action: "record.create", resourceType: "record.ticket" }),
          grant({ action: "*", resourceType: "platform.knowledge" }),
        ],
      })
    );
    expect(summary.areas.map((area) => area.id)).toEqual(["records", "knowledge"]);
    expect(summary.unrestricted).toBe(false);
  });

  /*
   * A deny is not reach. Counting one would put "People and access" on a Role whose only mention
   * of it is a prohibition — the exact inversion an owner cannot afford to misread.
   */
  test("ignores denies when working out what a Role covers", () => {
    const summary = summarizeRole(
      role({
        grants: [
          grant({ effect: "deny", action: "*", resourceType: "user" }),
          grant({ action: "*", resourceType: "chat" }),
        ],
      })
    );
    expect(summary.areas.map((area) => area.id)).toEqual(["everyday"]);
  });

  /*
   * A wildcard resource type is a scope, so the action names the area. Read literally it resolved
   * to the catch-all area and every coverage line ending in "and everything" — the same
   * wildcard-as-scale mistake that badged `member` Unrestricted.
   */
  test("names a wildcard grant by its action, not by everything", () => {
    const summary = summarizeRole(
      role({ grants: [grant({ action: "record.create", resourceType: "*" })] })
    );
    expect(summary.areas.map((area) => area.id)).toEqual(["records"]);
  });

  test("falls back to the catch-all area only when the action has no family", () => {
    const summary = summarizeRole(role({ grants: [grant({ action: "*", resourceType: "*" })] }));
    expect(summary.areas.map((area) => area.id)).toEqual(["everything"]);
  });

  test("says a Role with no grants grants nothing", () => {
    expect(summarizeRole(role({ grants: [] })).blurb).toBe("Grants nothing on its own.");
  });

  test("keeps the deployment's own wording for built-in Roles", () => {
    expect(summarizeRole(role({ id: "member", source: "builtin" })).title).toBe("Everyday access");
    expect(summarizeRole(role({ id: "owner", source: "builtin" })).title).toBe("Owner");
  });
});

describe("roleTitle", () => {
  test("humanizes an authored Role id", () => {
    expect(roleTitle("support-operators")).toBe("Support operators");
  });
});

describe("actionFor", () => {
  /*
   * Records namespace their actions by the *family*: a grant reads `record.read`, never
   * `record.customer.read`. Scoping the verb to the individual type would compile to an action no
   * grant can match, and the check would report a denial the real gate would never produce.
   */
  test("scopes a record verb to the family, not to the type", () => {
    expect(actionFor("record.customer", "read")).toBe("record.read");
    expect(actionFor("record", "delete")).toBe("record.delete");
  });

  test("scopes any other verb to the resource type itself", () => {
    expect(actionFor("platform.knowledge", "read")).toBe("platform.knowledge.read");
  });

  /*
   * `grantMatches` refuses to match any grant against a wildcard request, so "do anything with"
   * abstained on every grant and rendered an authoritative-looking denial for an owner holding
   * `allow * on *`. The verb is no longer offered, and nothing composes one.
   */
  test("does not offer a verb the gate can only ever answer no to", () => {
    expect(CHECKABLE_VERBS.map((verb) => verb.value)).not.toContain("*");
  });

  /*
   * These three surfaces do not speak CRUD. Composing `integration.create` produced an action that
   * exists nowhere, so it matched neither the allows nor the explicit deny and the page reported
   * "Nobody has given them this yet" with a remedy that a deny would beat anyway.
   */
  test("names the real action for a surface whose vocabulary is not CRUD", () => {
    expect(actionFor("integration", "create")).toBe("integration.connect");
    expect(actionFor("secret", "delete")).toBe("secret.delete");
    expect(actionFor("authz", "read")).toBe("authz.role.read");
  });

  test("refuses a verb that surface has no action for, rather than inventing one", () => {
    expect(actionFor("integration", "update")).toBeNull();
    expect(actionFor("authz", "update")).toBeNull();
  });

  /*
   * The level builder grants Records capabilities on the bare `record` family, so if this screen
   * cannot be asked about that family then the most likely level an owner will ever build is the
   * one level they cannot verify here.
   */
  test("offers the record family itself, which is what a Records level grants", () => {
    expect(CHECKABLE_THINGS.map((thing) => thing.value)).toContain("record");
    expect(actionFor("record", "create")).toBe("record.create");
  });

  test("does not offer a verb it would have to invent an action for", () => {
    expect(verbsFor("integration").map((verb) => verb.value)).toEqual(["read", "create", "delete"]);
    expect(verbsFor("secret").map((verb) => verb.value)).toEqual([
      "read",
      "create",
      "update",
      "delete",
    ]);
  });

  test("leaves every verb open for a surface that does speak CRUD", () => {
    expect(verbsFor("record.customer")).toEqual(CHECKABLE_VERBS);
    expect(verbsFor("")).toEqual(CHECKABLE_VERBS);
  });
});

describe("areaForResourceType", () => {
  test("returns null for something it does not recognise", () => {
    expect(areaForResourceType("payroll_ledger")).toBeNull();
  });

  test("claims every record type for the records area", () => {
    expect(areaForResourceType("record.anything")?.id).toBe("records");
  });

  test("offers each area exactly once", () => {
    const ids = accessAreas().map((area) => area.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("joinWords", () => {
  test.each([
    [[], ""],
    [["records"], "records"],
    [["records", "chat"], "records and chat"],
    [["records", "chat", "knowledge"], "records, chat and knowledge"],
  ])("%j reads as %s", (words, expected) => {
    expect(joinWords(words)).toBe(expected);
  });
});

/*
 * The page's whole purpose is to never show database vocabulary. A resource type that no area
 * claims falls through to its raw name, which is how "Full access to authz assignment" reached a
 * screenshot. These lock the families down: naming a parent claims its children, so a Soul-authored
 * Role that reaches for `authz.role` reads as access, not as a table.
 */
test("an area claims the children of the types it owns", () => {
  for (const child of ["authz.role", "authz.assignment", "authz.relation"]) {
    expect(areaForResourceType(child)?.id).toBe("people");
  }
  expect(areaForResourceType("identity.api_client")?.id).toBe("people");
  expect(areaForResourceType("secret.signing_key")?.id).toBe("apps");
  expect(areaForResourceType("platform.knowledge.chunk")?.id).toBe("knowledge");
});

test("an area that names a child exactly still beats its parent's namespace", () => {
  // `setup` owns `soul`, but an Agent is an automation, not business setup.
  expect(areaForResourceType("soul.agent")?.id).toBe("automations");
  expect(areaForResourceType("soul.surface_component")?.id).toBe("everyday");
  expect(areaForResourceType("soul.repo")?.id).toBe("setup");
  // A soul type nobody names exactly falls to the family that owns the namespace.
  expect(areaForResourceType("soul.glossary")?.id).toBe("setup");
});

test("no grant over a known family ever renders a dotted type name", () => {
  const familiar = [
    "authz.role",
    "authz.assignment",
    "identity.api_client",
    "soul.repo",
    "platform.knowledge",
    "secret.signing_key",
  ];
  for (const type of familiar) {
    expect(describeResourceType(type)).not.toContain(".");
    expect(describeResourceType(type)).not.toContain("_");
  }
});

test("a wholly unknown top-level type is still shown as itself, never widened", () => {
  expect(areaForResourceType("quantum_flux")).toBeNull();
  expect(describeResourceType("quantum_flux")).toBe("quantum flux");
});

/*
 * `resourceType: "*"` is a scope, not a scale. The member Role grants `record.create` on `*`,
 * meaning "create records, on any resource" — rendered literally it said "Add to everything", which
 * both overstates the grant and reads as alarming next to a list of ordinary permissions.
 */
describe("a wildcard resource type", () => {
  test("takes its object from the action's own family", () => {
    expect(describeGrant(grant({ action: "record.create", resourceType: "*" }))).toBe(
      "Add to records"
    );
    expect(describeGrant(grant({ action: "record.read", resourceType: "*" }))).toBe("View records");
    expect(describeGrant(grant({ action: "integration.read", resourceType: "*" }))).toBe(
      "View connected apps"
    );
  });

  test("collapses onto the same phrase as the narrowed grant it duplicates", () => {
    const wide = describeGrant(grant({ action: "record.create", resourceType: "*" }));
    const narrow = describeGrant(grant({ action: "record.create", resourceType: "record" }));
    expect(wide).toBe(narrow);
  });

  test("still says everything when the action has no family to name", () => {
    expect(describeGrant(grant({ action: "read", resourceType: "*" }))).toBe("View everything");
  });

  test("an unrestricted action on an unrestricted resource is the only true 'anything'", () => {
    expect(describeGrant(grant({ action: "*", resourceType: "*" }))).toBe("Do anything");
  });
});

/*
 * The same wildcard-as-scale error that produced "Add to everything", one layer up. `member`
 * allows `record.create` on `*` — records anywhere, not anything anywhere — and badging that Role
 * "Unrestricted" contradicted its own blurb ("Cannot manage people or settings") on the line
 * above. A Role is unbounded only when both halves are wild.
 */
test("a wildcard resource type alone does not make a Role unrestricted", () => {
  const summary = summarizeRole(
    role({
      grants: [
        { effect: "allow", action: "record.create", resourceType: "*", label: "" },
        { effect: "allow", action: "record.read", resourceType: "*", label: "" },
      ],
    })
  );

  expect(summary.unrestricted).toBe(false);
});

test("a Role wild on both halves is unrestricted", () => {
  const summary = summarizeRole(
    role({ grants: [{ effect: "allow", action: "*", resourceType: "*", label: "" }] })
  );

  expect(summary.unrestricted).toBe(true);
});
