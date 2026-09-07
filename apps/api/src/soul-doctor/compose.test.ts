import type { SoulWriteRequest, SoulWriter } from "@tulipfarm/soul";
import { SoulWriteError } from "@tulipfarm/soul";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildSoulDoctor } from "./compose";

const storage = vi.hoisted(() => ({
  observe: vi.fn(async () => ({ state: "open", attempts: 0 })),
  claim: vi.fn(async () => true),
  settle: vi.fn(async () => undefined),
  resolveUnseen: vi.fn(async () => 0),
  listUnhealthyRuns: vi.fn(async () => []),
  closeSupersededRuns: vi.fn(async () => undefined),
}));

const proposeSoulRepair = vi.hoisted(() => vi.fn());

vi.mock("@tulipfarm/built-in-agents", () => ({ proposeSoulRepair }));
vi.mock("@tulipfarm/storage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tulipfarm/storage")>()),
  closeSupersededRuns: storage.closeSupersededRuns,
  listUnhealthyRuns: storage.listUnhealthyRuns,
  SoulDoctorLedger: class {
    observe = storage.observe;
    claim = storage.claim;
    settle = storage.settle;
    resolveUnseen = storage.resolveUnseen;
  },
}));

const brokenRoutine = {
  apiVersion: "tulipfarm.ai/v1",
  kind: "Routine",
  metadata: {
    id: "11111111-2222-4333-8444-555555555555",
    slug: "quotes",
    schemaVersion: 1,
    authoredVersion: 1,
    lifecycle: "published",
  },
  spec: {
    owner: "platform",
    start: "Start",
    states: [{ type: "compute", name: "Start", input: { ok: true }, transition: "Nowhere" }],
  },
};

const repairedRoutine = `apiVersion: tulipfarm.ai/v1
kind: Routine
metadata:
  id: 11111111-2222-4333-8444-555555555555
  slug: quotes
  schemaVersion: 1
  authoredVersion: 1
  lifecycle: published
spec:
  owner: platform
  start: Start
  states:
    - type: compute
      name: Start
      input:
        ok: true
      end: true
`;

describe("buildSoulDoctor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects a repair when a user edits the Routine during the model call", async () => {
    let currentBase = "base-commit";
    let appliedContent: string | null = null;
    const apply = vi.fn(async (request: SoulWriteRequest) => {
      if (request.expectedBaseCommit !== undefined && request.expectedBaseCommit !== currentBase) {
        throw new SoulWriteError("CONFLICT", "Soul write: base commit stale");
      }
      appliedContent = (request.changes[0] as { content: string }).content;
      return {
        commitSha: "repair-commit",
        filesChanged: 1,
        paths: ["routines/quotes/routine.yaml"],
        pushed: true,
        published: true,
      };
    });
    const writer = {
      readWithBase: vi.fn(async () => ({
        content: "broken authored bytes",
        baseCommit: currentBase,
      })),
      apply,
    } as unknown as SoulWriter;
    proposeSoulRepair.mockImplementationOnce(async () => {
      currentBase = "user-edit-commit";
      return { repairable: true, content: repairedRoutine, summary: "repair mapping" };
    });
    const upsertOpen = vi.fn(async () => undefined);

    const doctor = buildSoulDoctor({
      pool: {} as never,
      businessId: "business-1",
      soul: { routines: new Map([["quotes", { config: brokenRoutine }]]) },
      writer,
      actor: {
        principalId: "system:soul-doctor",
        email: "system@tulipfarm.local",
        name: "Soul Doctor",
      },
      tasks: { upsertOpen } as never,
      activity: { record: vi.fn(async () => undefined) } as never,
      llm: {
        isConfigured: true,
        effortModel: vi.fn(() => ({})),
      } as never,
      headSha: async () => "published-commit",
      activeCommitSha: async () => "published-commit",
    });

    const report = await doctor.sweep();

    expect(report).toMatchObject({ found: 1, repaired: 0, escalated: 1 });
    expect(apply).toHaveBeenCalledWith(
      expect.objectContaining({ expectedBaseCommit: "base-commit" })
    );
    expect(appliedContent).toBeNull();
    expect(upsertOpen).toHaveBeenCalledWith(
      expect.objectContaining({
        detail: expect.stringContaining("base commit stale"),
      }),
      expect.any(Date)
    );
  });
});
