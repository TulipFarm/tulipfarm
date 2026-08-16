import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("./agents", () => ({ listAgents: vi.fn() }));
vi.mock("./api", () => ({ listResourceTypes: vi.fn() }));
vi.mock("./integrations", () => ({ listIntegrations: vi.fn() }));
vi.mock("./knowledge-api", () => ({ listSpaces: vi.fn() }));
vi.mock("./routines", () => ({ listRoutines: vi.fn() }));
vi.mock("./skills", () => ({ listSkills: vi.fn() }));

import { listAgents } from "./agents";
import { listResourceTypes } from "./api";
import {
  CROPS,
  type CropKind,
  countsFor,
  cropFor,
  farmSeason,
  fetchFarm,
  loadFarm,
  type Planting,
  plantingSeed,
} from "./farm";
import { listIntegrations } from "./integrations";
import { listSpaces } from "./knowledge-api";
import { listRoutines } from "./routines";
import { listSkills } from "./skills";

const mocks = {
  agents: vi.mocked(listAgents),
  resourceTypes: vi.mocked(listResourceTypes),
  integrations: vi.mocked(listIntegrations),
  spaces: vi.mocked(listSpaces),
  routines: vi.mocked(listRoutines),
  skills: vi.mocked(listSkills),
};

function allEmpty() {
  mocks.agents.mockResolvedValue([]);
  mocks.resourceTypes.mockResolvedValue([]);
  mocks.integrations.mockResolvedValue([]);
  mocks.spaces.mockResolvedValue({ items: [], nextCursor: null });
  mocks.routines.mockResolvedValue([]);
  mocks.skills.mockResolvedValue([]);
}

beforeEach(() => {
  vi.clearAllMocks();
  allEmpty();
});

test("every crop takes a distinct colour from the categorical data palette", () => {
  const vars = CROPS.map((crop) => crop.colorVar);
  expect(new Set(vars).size).toBe(CROPS.length);
  for (const colorVar of vars) expect(colorVar).toMatch(/^--data-[1-8]$/);
});

test("crop lookup is total over the kinds a planting can carry", () => {
  for (const crop of CROPS) expect(cropFor(crop.kind).kind).toBe(crop.kind);
});

describe("plantingSeed", () => {
  test("is stable for an id, so a farm keeps its shape between visits", () => {
    expect(plantingSeed("skill:forecasting")).toBe(plantingSeed("skill:forecasting"));
  });

  test("separates ids and stays inside the unit interval", () => {
    const seeds = ["a", "b", "skill:a", "agent:a"].map(plantingSeed);
    expect(new Set(seeds).size).toBe(seeds.length);
    for (const seed of seeds) {
      expect(seed).toBeGreaterThanOrEqual(0);
      expect(seed).toBeLessThanOrEqual(1);
    }
  });
});

describe("farmSeason", () => {
  const grown = (...kinds: CropKind[]) =>
    countsFor(
      kinds.map((kind) => ({
        id: `x:${kind}`,
        kind,
        name: kind,
        href: "/",
        bloomed: true,
      }))
    );

  test("names the farm by how much of the crop catalog it grows", () => {
    expect(grown()).toBeDefined();
    expect(farmSeason(grown()).name).toBe("Bare soil");
    expect(farmSeason(grown("skill")).name).toBe("First bed");
    expect(farmSeason(grown("skill", "agent")).name).toBe("Mixed beds");
    expect(farmSeason(grown(...CROPS.slice(0, 5).map((crop) => crop.kind))).name).toBe(
      "Broad farm"
    );
    expect(farmSeason(grown(...CROPS.map((crop) => crop.kind))).name).toBe("Full tulip farm");
  });

  test("counts against a real denominator and names what is still missing", () => {
    const season = farmSeason(grown("skill", "skill", "agent"));
    expect(season.crops).toBe(2);
    expect(season.ofCrops).toBe(CROPS.length);
    expect(season.missing).not.toContain("skill");
    expect(season.missing).toHaveLength(CROPS.length - 2);
  });

  test("has nothing missing once every crop is growing", () => {
    expect(farmSeason(grown(...CROPS.map((crop) => crop.kind))).missing).toEqual([]);
  });
});

test("countsFor tallies each kind and leaves absent kinds at zero", () => {
  const plantings = [
    { id: "skill:a", kind: "skill", name: "a", href: "/skills/a", bloomed: true },
    { id: "skill:b", kind: "skill", name: "b", href: "/skills/b", bloomed: true },
    { id: "agent:c", kind: "agent", name: "c", href: "/agents/c", bloomed: true },
  ] satisfies Planting[];

  expect(countsFor(plantings)).toEqual({
    resource: 0,
    agent: 1,
    skill: 2,
    routine: 0,
    integration: 0,
    space: 0,
  });
});

describe("fetchFarm", () => {
  test("turns every crop into a planting with a stable id and a reachable href", async () => {
    mocks.resourceTypes.mockResolvedValue([{ name: "ticket", schema: "{}", hasHooks: false }]);
    mocks.agents.mockResolvedValue([{ name: "triage", label: "Triage", domain: "support" }]);
    mocks.skills.mockResolvedValue([{ name: "forecasting", provenance: "user" }]);
    mocks.spaces.mockResolvedValue({
      items: [
        {
          id: "s1",
          name: "Ops",
          description: null,
          createdAt: "2026-01-01",
          updatedAt: "2026-01-01",
        },
      ],
      nextCursor: null,
    });

    const farm = await fetchFarm();

    expect(farm.total).toBe(4);
    expect(farm.failed).toEqual([]);
    expect(farm.counts).toMatchObject({ resource: 1, agent: 1, skill: 1, space: 1 });
    expect(farm.plantings.map((planting) => planting.id).sort()).toEqual([
      "agent:triage",
      "resource:ticket",
      "skill:forecasting",
      "space:s1",
    ]);
    expect(farm.plantings.find((planting) => planting.kind === "agent")).toMatchObject({
      name: "Triage",
      href: "/agents/triage",
    });
  });

  test("plants what this business built, not what ships with every instance", async () => {
    mocks.skills.mockResolvedValue([
      { name: "business-records", provenance: "builtin" },
      { name: "onboarding", provenance: "builtin" },
      { name: "forecasting", provenance: "user" },
      { name: "invoicing", provenance: "marketplace" },
    ]);
    // Every manifest bundled with the deployment reports `installed: true` on a brand-new
    // instance. Connecting one is the act that earns a tulip.
    mocks.integrations.mockResolvedValue([
      { name: "github", type: "mcp", installed: true, status: "connected" },
      { name: "slack", type: "mcp", installed: true, status: "disconnected" },
      { name: "confluence", type: "openapi", installed: true, status: "disconnected" },
    ]);

    const farm = await fetchFarm();

    expect(farm.counts).toMatchObject({ skill: 2, integration: 1 });
    expect(farm.plantings.map((planting) => planting.id).sort()).toEqual([
      "integration:github",
      "skill:forecasting",
      "skill:invoicing",
    ]);
  });

  test("blooms only what can act: a triggerless routine stays a bud", async () => {
    mocks.routines.mockResolvedValue([
      {
        id: "r1",
        slug: "nightly",
        displayName: "Nightly",
        authoredVersion: 1,
        triggers: [{ slug: "t", type: "schedule", summary: "daily" }],
      },
      { id: "r2", slug: "draft", displayName: null, authoredVersion: 1, triggers: [] },
    ]);
    mocks.integrations.mockResolvedValue([
      { name: "github", type: "mcp", installed: true, status: "connected" },
    ]);

    const farm = await fetchFarm();
    const bloomed = Object.fromEntries(
      farm.plantings.map((planting) => [planting.id, planting.bloomed])
    );

    expect(bloomed).toEqual({
      "routine:nightly": true,
      "routine:draft": false,
      "integration:github": true,
    });
  });

  test("leaves the untouched catalogue out of the field entirely", async () => {
    mocks.integrations.mockResolvedValue([
      { name: "notion", type: "mcp", installed: false, status: "disconnected" },
      { name: "slack", type: "mcp", installed: true, status: "disconnected" },
    ]);
    mocks.skills.mockResolvedValue([{ name: "onboarding", provenance: "builtin" }]);

    const farm = await fetchFarm();
    expect(farm.total).toBe(0);
    expect(farm.failed).toEqual([]);
  });

  test("keeps the rest of the field when one crop fails", async () => {
    mocks.skills.mockResolvedValue([{ name: "forecasting", provenance: "user" }]);
    mocks.spaces.mockRejectedValue(new Error("knowledge is down"));

    const farm = await fetchFarm();

    expect(farm.failed).toEqual(["space"]);
    expect(farm.total).toBe(1);
  });

  test("throws only when every crop fails, so a dead API is not drawn as an empty farm", async () => {
    const boom = new Error("api unreachable");
    for (const mock of Object.values(mocks)) mock.mockRejectedValue(boom);

    await expect(fetchFarm()).rejects.toThrow("api unreachable");
  });

  test("orders plantings by seed, so crops interleave instead of banding by kind", async () => {
    mocks.skills.mockResolvedValue([
      { name: "a", provenance: "user" },
      { name: "b", provenance: "user" },
    ]);
    mocks.agents.mockResolvedValue([{ name: "a" }, { name: "b" }]);

    const farm = await fetchFarm();
    const seeds = farm.plantings.map((planting) => plantingSeed(planting.id));

    expect(seeds).toEqual([...seeds].sort((a, b) => a - b));
  });
});

// Each case forces its first read to start from a cold cache. A test-only reset hook would be an
// export production never calls, so the cases use the same escape the callers have.
describe("loadFarm", () => {
  test("shares one round of calls between the page and the sidebar", async () => {
    await Promise.all([loadFarm({ force: true }), loadFarm()]);
    expect(mocks.skills).toHaveBeenCalledTimes(1);
  });

  test("refetches when forced", async () => {
    await loadFarm({ force: true });
    await loadFarm({ force: true });
    expect(mocks.skills).toHaveBeenCalledTimes(2);
  });

  test("does not cache a failure, so one blackout does not pin the whole TTL", async () => {
    const boom = new Error("api unreachable");
    for (const mock of Object.values(mocks)) mock.mockRejectedValue(boom);
    await expect(loadFarm({ force: true })).rejects.toThrow();

    allEmpty();
    await expect(loadFarm()).resolves.toMatchObject({ total: 0 });
  });
});
