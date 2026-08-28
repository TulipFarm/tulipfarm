import { describe, expect, it } from "vitest";
import type { RuntimeBundle } from "./bundle";
import { ActiveRoutineCatalog } from "./routine-catalog";

function bundle(): RuntimeBundle {
  const definitions = [
    {
      kind: "Routine",
      id: "routine-published",
      slug: "daily-wait",
      authoredVersion: 3,
      hash: "routine-hash",
      document: {
        apiVersion: "tulipfarm.ai/v1",
        kind: "Routine",
        metadata: {
          id: "routine-published",
          slug: "daily-wait",
          displayName: "Daily wait",
          schemaVersion: 1,
          authoredVersion: 3,
          lifecycle: "published",
        },
        spec: {
          owner: "operations",
          start: "Wait",
          states: [],
          triggers: [{ name: "daily-wait-cron", type: "cron", expression: "0 9 * * *" }],
        },
      },
      references: [],
    },
    {
      kind: "Routine",
      id: "routine-draft",
      slug: "draft-routine",
      authoredVersion: 1,
      hash: "draft-hash",
      document: {
        apiVersion: "tulipfarm.ai/v1",
        kind: "Routine",
        metadata: {
          id: "routine-draft",
          slug: "draft-routine",
          schemaVersion: 1,
          authoredVersion: 1,
          lifecycle: "draft",
        },
        spec: { owner: "operations", start: "Wait", states: [] },
      },
      references: [],
    },
  ];
  return {
    digest: "bundle-digest",
    businessId: "business-1",
    changesetId: "changeset-1",
    commitSha: "commit-1",
    definitions,
    assets: [],
    get: (kind, slug) => definitions.find((item) => item.kind === kind && item.slug === slug),
    getById: (id) => definitions.find((item) => item.id === id),
    asset: () => undefined,
  };
}

describe("ActiveRoutineCatalog", () => {
  it("returns only published Routines and their published Trigger summaries", async () => {
    const catalog = new ActiveRoutineCatalog(async () => bundle());

    await expect(catalog.list()).resolves.toEqual([
      {
        id: "routine-published",
        slug: "daily-wait",
        displayName: "Daily wait",
        authoredVersion: 3,
        triggers: [
          {
            slug: "daily-wait-cron",
            type: "cron",
            summary: "cron 0 9 * * *",
          },
        ],
      },
    ]);
  });

  it("serves one published Routine with the document the bundle carries", async () => {
    const catalog = new ActiveRoutineCatalog(async () => bundle());

    const detail = await catalog.get("daily-wait");

    expect(detail?.definition).toEqual(bundle().get("Routine", "daily-wait")?.document);
    expect(detail?.bundleDigest).toBe("bundle-digest");
    expect(detail?.triggers).toEqual([
      { slug: "daily-wait-cron", type: "cron", summary: "cron 0 9 * * *" },
    ]);
  });

  it("hides a Routine the bundle carries but does not publish", async () => {
    const catalog = new ActiveRoutineCatalog(async () => bundle());

    await expect(catalog.get("draft-routine")).resolves.toBeUndefined();
    await expect(catalog.get("no-such-routine")).resolves.toBeUndefined();
  });

  it("returns an empty catalogue when no active bundle exists", async () => {
    const catalog = new ActiveRoutineCatalog(async () => undefined);

    await expect(catalog.list()).resolves.toEqual([]);
    await expect(catalog.get("daily-wait")).resolves.toBeUndefined();
  });
});

/** A published Routine carrying exactly one Trigger, so a summary can be read on its own. */
function bundleWithTrigger(trigger: Record<string, unknown>): RuntimeBundle {
  const definitions = [
    {
      kind: "Routine",
      id: "routine-published",
      slug: "scheduled",
      authoredVersion: 1,
      hash: "routine-hash",
      document: {
        apiVersion: "tulipfarm.ai/v1",
        kind: "Routine",
        metadata: {
          id: "routine-published",
          slug: "scheduled",
          schemaVersion: 1,
          authoredVersion: 1,
          lifecycle: "published",
        },
        spec: { owner: "operations", start: "Wait", states: [], triggers: [trigger] },
      },
      references: [],
    },
  ];
  return {
    digest: "bundle-digest",
    businessId: "business-1",
    changesetId: "changeset-1",
    commitSha: "commit-1",
    definitions,
    assets: [],
    get: (kind, slug) => definitions.find((item) => item.kind === kind && item.slug === slug),
    getById: (id) => definitions.find((item) => item.id === id),
    asset: () => undefined,
  };
}

async function summaryOf(trigger: Record<string, unknown>): Promise<string | undefined> {
  const catalog = new ActiveRoutineCatalog(async () => bundleWithTrigger(trigger));
  const [routine] = await catalog.list();
  return routine?.triggers[0]?.summary;
}

describe("triggerSummary — schedules read as a person would say them", () => {
  it.each([
    [120_000, "every 2 minutes"],
    [60_000, "every 1 minute"],
    [1_000, "every 1 second"],
    [30_000, "every 30 seconds"],
    [3_600_000, "every 1 hour"],
    [5_400_000, "every 1 hour 30 minutes"],
    [86_400_000, "every 1 day"],
    [90_000, "every 1 minute 30 seconds"],
  ])("says %ims as %s", async (everyMs, expected) => {
    await expect(summaryOf({ name: "t", type: "interval", everyMs })).resolves.toBe(expected);
  });

  it("keeps a sub-second interval in milliseconds, where no larger unit is honest", async () => {
    await expect(summaryOf({ name: "t", type: "interval", everyMs: 500 })).resolves.toBe(
      "every 500ms"
    );
  });

  it("stops at two units, because a third is noise at a schedule's size", async () => {
    // 1d 2h 3m 4s: the seconds and minutes do not change what the reader needs to know.
    await expect(summaryOf({ name: "t", type: "interval", everyMs: 93_784_000 })).resolves.toBe(
      "every 1 day 2 hours"
    );
  });

  it("names the zone on a one-off time rather than converting it silently", async () => {
    // Rendered where no viewer exists, so a converted time would look already local and mislead.
    await expect(
      summaryOf({ name: "t", type: "datetime", at: "2026-08-27T16:44:00.000Z" })
    ).resolves.toBe("at 2026-08-27 16:44 UTC");
  });

  it("passes an unparseable time through rather than inventing one", async () => {
    await expect(summaryOf({ name: "t", type: "datetime", at: "whenever" })).resolves.toBe(
      "at whenever"
    );
  });
});
