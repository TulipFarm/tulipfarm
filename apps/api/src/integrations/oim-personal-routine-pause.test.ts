import { canonicalHash, definitions } from "@tulipfarm/schema";
import { ActiveRoutineCatalog, makeSoulWriterDouble, type RuntimeBundle } from "@tulipfarm/soul";
import { type AssetOwnershipRecord, InMemoryAssetOwnershipRepo } from "@tulipfarm/storage";
import { describe, expect, it, vi } from "vitest";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { OimPersonalRoutinePause } from "./oim-personal-routine-pause";

const BUSINESS_ID = "business-1";
const USER_ID = "00000000-0000-4000-8000-000000000001";
const OTHER_USER_ID = "00000000-0000-4000-8000-000000000002";
const TEAM_ID = "00000000-0000-4000-8000-000000000003";

function routine(
  slug: string,
  id: string,
  owner: string,
  ownership?: { readonly owners: readonly [{ readonly teamId: string }] }
) {
  return definitions.routine.validateRoutineDefinition({
    apiVersion: "tulipfarm.ai/v1",
    kind: "Routine",
    metadata: {
      id,
      slug,
      schemaVersion: 1,
      authoredVersion: 1,
      lifecycle: "published",
      publishedDigest: "a".repeat(64),
    },
    spec: {
      owner,
      ...(ownership === undefined ? {} : { ownership }),
      start: "Start",
      states: [{ type: "compute", name: "Start", input: { value: 1 }, end: true }],
    },
  }).document;
}

function ownership(assetId: string): AssetOwnershipRecord {
  const at = new Date("2026-09-07T00:00:00.000Z");
  return {
    businessId: BUSINESS_ID,
    assetType: "routine",
    assetId,
    owners: [{ kind: "team", teamId: TEAM_ID }],
    shares: [],
    revision: 1,
    createdAt: at,
    updatedAt: at,
  };
}

function harness(
  documents: readonly ReturnType<typeof routine>[],
  ownershipRecords: readonly AssetOwnershipRecord[] = []
) {
  const authored = new Map(documents.map((document) => [document.metadata.slug, document]));
  const soul = makeSoulWriterDouble("base-1");
  for (const document of documents) {
    soul.put("Routine", document.metadata.slug, stringifyYaml(document));
  }

  const activeBundle = async (): Promise<RuntimeBundle> => {
    const bundleDefinitions = [...authored.values()].map((document) => ({
      kind: "Routine",
      id: document.metadata.id,
      slug: document.metadata.slug,
      authoredVersion: document.metadata.authoredVersion,
      hash: canonicalHash(document),
      document,
      references: [],
    }));
    return {
      digest: "bundle-1",
      businessId: BUSINESS_ID,
      changesetId: "changeset-1",
      commitSha: "commit-1",
      definitions: bundleDefinitions,
      assets: [],
      get: (kind, slug) =>
        bundleDefinitions.find(
          (definition) => definition.kind === kind && definition.slug === slug
        ),
      getById: (id) => bundleDefinitions.find((definition) => definition.id === id),
      asset: () => undefined,
    };
  };

  const onRoutinesChanged = vi.fn(async () => {
    for (const slug of authored.keys()) {
      const content = soul.writer.read("Routine", slug);
      if (content === null) continue;
      authored.set(
        slug,
        definitions.routine.validateRoutineDefinition(parseYaml(content)).document
      );
    }
  });
  const pause = new OimPersonalRoutinePause({
    businessId: BUSINESS_ID,
    routines: new ActiveRoutineCatalog(activeBundle),
    ownership: new InMemoryAssetOwnershipRepo(ownershipRecords),
    soulWriter: soul.writer,
    onRoutinesChanged,
  });

  return { pause, soul, onRoutinesChanged };
}

function writtenRoutine(
  soul: ReturnType<typeof makeSoulWriterDouble>,
  slug: string
): ReturnType<typeof routine> {
  return definitions.routine.validateRoutineDefinition(
    parseYaml(soul.writer.read("Routine", slug) ?? "")
  ).document;
}

describe("OimPersonalRoutinePause", () => {
  it("retires only the disabled user's personal Routines", async () => {
    const personal = routine(
      "my-digest",
      "00000000-0000-4000-8000-000000000011",
      `user:${USER_ID}`
    );
    const otherPersonal = routine(
      "their-digest",
      "00000000-0000-4000-8000-000000000012",
      `user:${OTHER_USER_ID}`
    );
    const organization = routine(
      "company-digest",
      "00000000-0000-4000-8000-000000000013",
      "organization"
    );
    const team = routine("team-digest", "00000000-0000-4000-8000-000000000014", `user:${USER_ID}`, {
      owners: [{ teamId: TEAM_ID }],
    });
    const projectedTeam = routine(
      "projected-team-digest",
      "00000000-0000-4000-8000-000000000015",
      `user:${USER_ID}`
    );
    const { pause, soul, onRoutinesChanged } = harness(
      [personal, otherPersonal, organization, team, projectedTeam],
      [ownership(projectedTeam.metadata.id)]
    );

    await pause.pausePersonalRoutines({ businessId: BUSINESS_ID, userId: USER_ID });

    expect(writtenRoutine(soul, "my-digest")).toMatchObject({
      metadata: { authoredVersion: 2, lifecycle: "retired" },
      spec: personal.spec,
    });
    expect(writtenRoutine(soul, "my-digest").metadata).not.toHaveProperty("publishedDigest");
    for (const untouched of [otherPersonal, organization, team, projectedTeam]) {
      expect(writtenRoutine(soul, untouched.metadata.slug)).toEqual(untouched);
    }
    expect(soul.applied).toHaveLength(1);
    expect(soul.applied[0]).toMatchObject({
      subject: "soul: pause personal routine my-digest",
      source: "api",
      businessId: BUSINESS_ID,
      expectedBaseCommit: "base-1",
      preconditions: [{ kind: "Routine", slug: "my-digest", state: "present" }],
    });
    expect(onRoutinesChanged).toHaveBeenCalledOnce();

    await pause.pausePersonalRoutines({ businessId: BUSINESS_ID, userId: USER_ID });

    expect(soul.applied).toHaveLength(1);
    expect(onRoutinesChanged).toHaveBeenCalledOnce();
  });

  it("continues after one Routine fails and completes it on retry", async () => {
    const first = routine("a-personal", "00000000-0000-4000-8000-000000000021", `user:${USER_ID}`);
    const second = routine("b-personal", "00000000-0000-4000-8000-000000000022", `user:${USER_ID}`);
    const { pause, soul } = harness([first, second]);
    const failure = new Error("Soul unavailable");
    soul.failNextWith(failure);

    await expect(
      pause.pausePersonalRoutines({ businessId: BUSINESS_ID, userId: USER_ID })
    ).rejects.toSatisfy(
      (error: unknown) => error instanceof AggregateError && error.errors.includes(failure)
    );
    expect(writtenRoutine(soul, "a-personal").metadata.lifecycle).toBe("published");
    expect(writtenRoutine(soul, "b-personal").metadata.lifecycle).toBe("retired");

    await expect(
      pause.pausePersonalRoutines({ businessId: BUSINESS_ID, userId: USER_ID })
    ).resolves.toBeUndefined();
    expect(writtenRoutine(soul, "a-personal").metadata.lifecycle).toBe("retired");
  });

  it("does not recommit when the catalog stays stale after a reload failure", async () => {
    const original = routine("personal", "00000000-0000-4000-8000-000000000029", `user:${USER_ID}`);
    const { pause, soul, onRoutinesChanged } = harness([original]);
    const reloadFailure = new Error("Routine reload unavailable");
    onRoutinesChanged.mockRejectedValueOnce(reloadFailure);

    await expect(
      pause.pausePersonalRoutines({ businessId: BUSINESS_ID, userId: USER_ID })
    ).rejects.toSatisfy(
      (error: unknown) => error instanceof AggregateError && error.errors.includes(reloadFailure)
    );
    expect(soul.applied).toHaveLength(1);
    expect(writtenRoutine(soul, "personal").metadata).toMatchObject({
      authoredVersion: 2,
      lifecycle: "retired",
    });

    await expect(
      pause.pausePersonalRoutines({ businessId: BUSINESS_ID, userId: USER_ID })
    ).resolves.toBeUndefined();
    expect(soul.applied).toHaveLength(1);
    expect(writtenRoutine(soul, "personal").metadata.authoredVersion).toBe(2);
    expect(onRoutinesChanged).toHaveBeenCalledTimes(2);
  });

  it("retries publication without recommitting an authored retirement", async () => {
    const original = routine("personal", "00000000-0000-4000-8000-000000000030", `user:${USER_ID}`);
    const { pause, soul, onRoutinesChanged } = harness([original]);
    const apply = soul.writer.apply.bind(soul.writer);
    vi.spyOn(soul.writer, "apply").mockImplementationOnce(async (request) => ({
      ...(await apply(request)),
      published: false,
      publicationError: "publisher unavailable",
    }));
    onRoutinesChanged.mockImplementationOnce(async () => {});

    await expect(
      pause.pausePersonalRoutines({ businessId: BUSINESS_ID, userId: USER_ID })
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof AggregateError &&
        error.errors.some(
          (cause) => cause instanceof Error && cause.message.includes("was not published")
        )
    );
    expect(writtenRoutine(soul, "personal").metadata.lifecycle).toBe("retired");

    await expect(
      pause.pausePersonalRoutines({ businessId: BUSINESS_ID, userId: USER_ID })
    ).resolves.toBeUndefined();
    expect(soul.applied).toHaveLength(1);
    expect(writtenRoutine(soul, "personal").metadata.authoredVersion).toBe(2);
    expect(onRoutinesChanged).toHaveBeenCalledTimes(2);
  });

  it("rejects another deployment's offboarding request", async () => {
    const { pause, soul } = harness([
      routine("personal", "00000000-0000-4000-8000-000000000031", `user:${USER_ID}`),
    ]);

    await expect(
      pause.pausePersonalRoutines({ businessId: "business-2", userId: USER_ID })
    ).rejects.toThrow("business-2");
    expect(soul.applied).toHaveLength(0);
  });
});
