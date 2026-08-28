import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { embedTriggersInRoutines } from "./003-embed-triggers";

const TMP = join(import.meta.dirname, "__embed_triggers_tmp__");

async function writeRoutine(slug: string, spec: Record<string, unknown> = {}): Promise<void> {
  await mkdir(join(TMP, "routines", slug), { recursive: true });
  await writeFile(
    join(TMP, "routines", slug, "routine.yaml"),
    stringifyYaml({
      apiVersion: "tulipfarm.ai/v1",
      kind: "Routine",
      metadata: {
        id: "11111111-1111-4111-8111-111111111111",
        slug,
        schemaVersion: 1,
        authoredVersion: 1,
        lifecycle: "published",
      },
      spec: { owner: "operations", start: "Decide", states: [], ...spec },
    }),
    "utf8"
  );
}

async function writeTrigger(
  slug: string,
  spec: Record<string, unknown> = { type: "manual" },
  routineSlug = "daily-report"
): Promise<void> {
  await mkdir(join(TMP, "triggers", slug), { recursive: true });
  await writeFile(
    join(TMP, "triggers", slug, "trigger.yaml"),
    stringifyYaml({
      apiVersion: "tulipfarm.ai/v1",
      kind: "Trigger",
      metadata: {
        id: "22222222-2222-4222-8222-222222222222",
        slug,
        schemaVersion: 1,
        authoredVersion: 1,
        lifecycle: "published",
      },
      spec: {
        eventType: "routine.manual",
        eventVersion: 1,
        backgroundIdentity: { principalKind: "service", principalId: "routine-runner" },
        deduplication: { key: slug },
        routineRef: { name: routineSlug, version: "1" },
        ...spec,
      },
    }),
    "utf8"
  );
}

async function readTriggers(slug = "daily-report"): Promise<Record<string, unknown>[]> {
  const raw = await readFile(join(TMP, "routines", slug, "routine.yaml"), "utf8");
  return (parseYaml(raw) as { spec: { triggers?: Record<string, unknown>[] } }).spec.triggers ?? [];
}

beforeEach(() => mkdir(TMP, { recursive: true }));
afterEach(() => rm(TMP, { recursive: true, force: true }));

describe("embedTriggersInRoutines", () => {
  it("folds a Trigger into its Routine, keeping its slug as the public address", async () => {
    await writeRoutine("daily-report");
    await writeTrigger("daily-report-manual");

    await embedTriggersInRoutines(TMP);

    // The name is what `/api/v1/hooks/:provider/:trigger` addresses, so changing it here would
    // break every webhook URL already registered with a third party.
    expect(await readTriggers()).toEqual([
      expect.objectContaining({ name: "daily-report-manual", type: "manual" }),
    ]);
  });

  it("drops the routineRef, because containment now names the target", async () => {
    await writeRoutine("daily-report");
    await writeTrigger("daily-report-manual");

    await embedTriggersInRoutines(TMP);

    expect((await readTriggers())[0]).not.toHaveProperty("routineRef");
  });

  it("removes the retired directory once every Trigger is folded", async () => {
    await writeRoutine("daily-report");
    await writeTrigger("daily-report-manual");

    await embedTriggersInRoutines(TMP);

    await expect(readdir(join(TMP, "triggers"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("folds every Trigger of one Routine in a stable order", async () => {
    await writeRoutine("daily-report");
    await writeTrigger("daily-report-nightly", { type: "cron", expression: "0 9 * * *" });
    await writeTrigger("daily-report-manual");

    await embedTriggersInRoutines(TMP);

    expect((await readTriggers()).map((trigger) => trigger.name)).toEqual([
      "daily-report-manual",
      "daily-report-nightly",
    ]);
  });

  it("keeps Triggers already embedded in the Routine", async () => {
    await writeRoutine("daily-report", { triggers: [{ name: "already-here", type: "manual" }] });
    await writeTrigger("daily-report-manual");

    await embedTriggersInRoutines(TMP);

    expect((await readTriggers()).map((trigger) => trigger.name)).toEqual([
      "already-here",
      "daily-report-manual",
    ]);
  });

  it("sends each Trigger to the Routine it names, not to the first one", async () => {
    await writeRoutine("daily-report");
    await writeRoutine("weekly-report");
    await writeTrigger(
      "weekly-report-cron",
      { type: "cron", expression: "0 9 * * 1" },
      "weekly-report"
    );

    await embedTriggersInRoutines(TMP);

    expect(await readTriggers("daily-report")).toEqual([]);
    expect(await readTriggers("weekly-report")).toEqual([
      expect.objectContaining({ name: "weekly-report-cron" }),
    ]);
  });

  // An orphan could never have started a Run — the Routine it named was already gone — so keeping
  // it would only preserve a public address that resolves to nothing.
  it("drops a Trigger whose Routine no longer exists", async () => {
    await writeTrigger("ghost-manual", { type: "manual" }, "deleted-routine");

    await expect(embedTriggersInRoutines(TMP)).resolves.toBeUndefined();
    await expect(readdir(join(TMP, "triggers"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("no-ops when the retired directory is absent", async () => {
    await expect(embedTriggersInRoutines(TMP)).resolves.toBeUndefined();
  });

  // Folding half a Soul and deleting the directory would lose the rest with no way back, so an
  // unreadable Trigger has to stop the migration before anything is written.
  it("refuses before writing when a Trigger names no Routine", async () => {
    await writeRoutine("daily-report");
    await writeTrigger("daily-report-manual");
    await mkdir(join(TMP, "triggers", "broken"), { recursive: true });
    await writeFile(
      join(TMP, "triggers", "broken", "trigger.yaml"),
      "apiVersion: tulipfarm.ai/v1\nkind: Trigger\nspec:\n  type: manual\n",
      "utf8"
    );

    await expect(embedTriggersInRoutines(TMP)).rejects.toThrow(/routineRef/);
    expect(await readTriggers()).toEqual([]);
    expect(await readdir(join(TMP, "triggers"))).toContain("daily-report-manual");
  });
});
