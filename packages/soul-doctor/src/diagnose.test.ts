import type { routine as routineSchema } from "@tulipfarm/schema";
import { describe, expect, it } from "vitest";
import { type BundleState, diagnoseSoul } from "./diagnose";

function routine(slug: string, states: readonly unknown[]): routineSchema.RoutineDefinition {
  return {
    apiVersion: "tulipfarm.ai/v1",
    kind: "Routine",
    metadata: {
      id: "11111111-2222-4333-8444-555555555555",
      slug,
      schemaVersion: 1,
      authoredVersion: 1,
      lifecycle: "published",
    },
    spec: { owner: "platform", start: "Start", states },
  } as unknown as routineSchema.RoutineDefinition;
}

const HEALTHY = [{ type: "compute", name: "Start", input: { ok: true }, end: true }];

function state(overrides: Partial<BundleState> = {}): BundleState {
  return {
    activeCommitSha: "abc123",
    headSha: "abc123",
    routines: [{ slug: "ok", hash: "h1", document: routine("ok", HEALTHY) }],
    ...overrides,
  };
}

describe("diagnoseSoul", () => {
  it("finds nothing in a bundle that is current and compiles", () => {
    expect(diagnoseSoul(state())).toEqual([]);
  });

  // Publication is all-or-nothing and its failure is only logged, so one unpublishable artifact
  // freezes every other one at the last good commit with nothing to say so.
  it("reports the Runtime serving an older commit than the repo's HEAD", () => {
    const [found] = diagnoseSoul(
      state({ headSha: "def456", lastPublicationError: "UNRESOLVED_REF: Agent:triage" })
    );
    expect(found).toMatchObject({ code: "bundle_stale", severity: "broken", at: "def456" });
    expect(found?.detail).toContain("UNRESOLVED_REF");
  });

  it("lints every published Routine, not only the one that changed", () => {
    const found = diagnoseSoul(
      state({
        routines: [
          { slug: "ok", hash: "h1", document: routine("ok", HEALTHY) },
          {
            slug: "broken",
            hash: "h2",
            document: routine("broken", [
              { type: "compute", name: "Start", input: {}, transition: "Nowhere" },
            ]),
          },
        ],
      })
    );
    expect(found).toHaveLength(1);
    // A transition to a State that does not exist is caught by the schema registry before the
    // compiler ever sees it, so the finding names the schema rather than the compile.
    expect(found[0]).toMatchObject({
      code: "routine_schema_invalid",
      subject: { kind: "routine", id: "broken", digest: "h2" },
    });
  });
});
