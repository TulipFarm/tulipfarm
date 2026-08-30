import { describe, expect, test } from "vitest";
import {
  capabilityFacts,
  groupByDomain,
  matchesQuery,
  reachOf,
  shouldGroupByDomain,
  UNGROUPED_DOMAIN,
} from "./agent-capabilities";
import type { AgentSummary } from "./agents";

const agent = (over: Partial<AgentSummary> = {}): AgentSummary => ({
  name: "sync",
  ...over,
});

describe("reachOf", () => {
  test("an agent with no restrictions block is unrestricted, not read-only", () => {
    expect(reachOf(undefined)).toBe("unrestricted");
    expect(reachOf({})).toBe("unrestricted");
  });

  test("allowMutating: false is the explicit answer and outranks the action list", () => {
    expect(
      reachOf({
        tools: { allowMutating: false },
        records: { actions: { allow: ["create", "update"] } },
      })
    ).toBe("read-only");
  });

  test("an allow-list of only reading actions is read-only", () => {
    expect(reachOf({ records: { actions: { allow: ["list", "search", "read"] } } })).toBe(
      "read-only"
    );
  });

  test("one writing action in the allow-list makes it change data", () => {
    expect(reachOf({ records: { actions: { allow: ["read", "update"] } } })).toBe("changes-data");
  });

  test("a tool allow-list with no action list still counts as restricted", () => {
    expect(reachOf({ tools: { allow: ["api_request"] } })).toBe("changes-data");
  });

  test("schema-writing power outweighs a read-only record allow-list", () => {
    expect(
      reachOf({
        records: { actions: { allow: ["list", "read"] } },
        resourceTypes: { actions: { allow: ["create", "update"] } },
      })
    ).toBe("changes-data");
  });

  test("a reading-only schema allow-list stays read-only", () => {
    expect(reachOf({ resourceTypes: { actions: { allow: ["list", "read"] } } })).toBe("read-only");
  });

  test("a skill deny-list on its own still counts as restricted", () => {
    expect(reachOf({ skills: { deny: ["deploy"] } })).toBe("changes-data");
  });

  test("a record action deny-list on its own still counts as restricted", () => {
    expect(reachOf({ records: { actions: { deny: ["delete"] } } })).toBe("changes-data");
  });

  test("a schema action deny-list on its own still counts as restricted", () => {
    expect(reachOf({ resourceTypes: { actions: { deny: ["create"] } } })).toBe("changes-data");
  });
});

describe("capabilityFacts", () => {
  test("record actions come back in their canonical order, not authoring order", () => {
    const facts = capabilityFacts({
      records: { actions: { allow: ["read", "list", "search"], deny: ["delete", "create"] } },
    });
    expect(facts.recordActionsAllowed).toEqual(["list", "search", "read"]);
    expect(facts.recordActionsDenied).toEqual(["create", "delete"]);
  });

  test("the headline names the record types when there are one or two", () => {
    const facts = capabilityFacts({
      tools: { allowMutating: false },
      records: { resourceTypes: ["github-star"] },
    });
    expect(facts.headline).toBe("Reads github-star.");
  });

  test("the headline counts record types once there are more than two", () => {
    const facts = capabilityFacts({
      records: { actions: { allow: ["create"] }, resourceTypes: ["a", "b", "c"] },
    });
    expect(facts.headline).toContain("3 record types");
  });

  test("an unrestricted agent says so rather than rendering as empty", () => {
    const facts = capabilityFacts(undefined);
    expect(facts.restricted).toBe(false);
    expect(facts.headline).toMatch(/No limits declared/);
  });

  test("a tool allow-list is counted in the headline", () => {
    const facts = capabilityFacts({
      tools: { allow: ["record_create", "record_update"] },
      records: { actions: { allow: ["create"] }, resourceTypes: ["github-star"] },
    });
    expect(facts.headline).toBe("Works on github-star, limited to 2 tools.");
  });

  test("the resource-type block is surfaced, not dropped", () => {
    const facts = capabilityFacts({
      resourceTypes: {
        actions: { allow: ["update", "list"], deny: ["create"] },
        names: ["ticket"],
      },
    });
    expect(facts.resourceTypeActionsAllowed).toEqual(["list", "update"]);
    expect(facts.resourceTypeActionsDenied).toEqual(["create"]);
    expect(facts.resourceTypeNames).toEqual(["ticket"]);
  });
});

describe("groupByDomain", () => {
  test("sorts domains alphabetically and keeps unlabelled agents last", () => {
    const groups = groupByDomain([
      agent({ name: "z", domain: "zeta" }),
      agent({ name: "n" }),
      agent({ name: "a", domain: "alpha" }),
    ]);
    expect(groups.map(([domain]) => domain)).toEqual(["alpha", "zeta", UNGROUPED_DOMAIN]);
  });

  test("headings are suppressed when every domain holds exactly one agent", () => {
    const groups = groupByDomain([
      agent({ name: "a", domain: "alpha" }),
      agent({ name: "b", domain: "beta" }),
    ]);
    expect(shouldGroupByDomain(groups)).toBe(false);
  });

  test("headings appear as soon as one domain collects two agents", () => {
    const groups = groupByDomain([
      agent({ name: "a", domain: "alpha" }),
      agent({ name: "b", domain: "alpha" }),
    ]);
    expect(shouldGroupByDomain(groups)).toBe(true);
  });
});

describe("matchesQuery", () => {
  const subject = agent({
    name: "github-stargazer-sync",
    label: "GitHub Stargazer Sync",
    domain: "github",
    description: "Fetches repository stargazers.",
    capabilityRestrictions: { records: { resourceTypes: ["github-star"] } },
  });

  test("an empty query matches everything", () => {
    expect(matchesQuery(subject, "   ")).toBe(true);
  });

  test("matches on the record type an agent is pointed at", () => {
    expect(matchesQuery(subject, "github-star")).toBe(true);
  });

  test("matches case-insensitively on the label and the description", () => {
    expect(matchesQuery(subject, "STARGAZER")).toBe(true);
    expect(matchesQuery(subject, "repository")).toBe(true);
  });

  test("does not match unrelated text", () => {
    expect(matchesQuery(subject, "invoice")).toBe(false);
  });
});
