import type { ArtifactService } from "@tulipfarm/run-kernel";
import type { RunStore } from "@tulipfarm/storage";
import { describe, expect, it } from "vitest";
import { subagentAnswerArtifactId, subagentAnswers } from "./subagent-answers";

const BUSINESS = "biz";
const CHILD_RUN = "00000000-0000-4000-8000-0000000000c1";

function harness(options: { status?: string | null; answer?: string; artifactMissing?: boolean }) {
  const reads: string[] = [];
  const runs = {
    find: async () =>
      options.status === undefined || options.status === null
        ? null
        : ({ id: CHILD_RUN, status: options.status } as Awaited<ReturnType<RunStore["find"]>>),
  } as Pick<RunStore, "find">;

  const artifacts = {
    read: async (input: { artifactId: string }) => {
      reads.push(input.artifactId);
      if (options.artifactMissing) throw new Error("artifact_not_found");
      return { content: { answer: options.answer ?? "done" } };
    },
  } as unknown as Pick<ArtifactService, "read">;

  return { reader: subagentAnswers({ runs, artifacts }), reads };
}

describe("subagentAnswers", () => {
  it("reports an unfinished helper as unfinished so the caller stays parked", async () => {
    const { reader } = harness({ status: "running" });

    expect(await reader.read(BUSINESS, CHILD_RUN)).toEqual({ status: null, answer: null });
  });

  it("returns the answer the helper published", async () => {
    const { reader, reads } = harness({ status: "succeeded", answer: "all clear" });

    expect(await reader.read(BUSINESS, CHILD_RUN)).toEqual({
      status: "succeeded",
      answer: "all clear",
    });
    expect(reads).toEqual([subagentAnswerArtifactId(CHILD_RUN)]);
  });

  it.each(["failed", "start_failed", "cancelled", "needs_reconciliation"])(
    "reports a %s helper as failed rather than leaving the caller parked",
    async (status) => {
      const { reader, reads } = harness({ status });

      expect(await reader.read(BUSINESS, CHILD_RUN)).toEqual({ status: "failed", answer: null });
      // A terminally failed Run has nothing to say, so reading its answer is wasted work.
      expect(reads).toEqual([]);
    }
  );

  it("reports a helper that succeeded without publishing an answer as failed", async () => {
    const { reader } = harness({ status: "succeeded", artifactMissing: true });

    // Reading the Artifact alone would make this look merely slow and park the caller forever.
    expect(await reader.read(BUSINESS, CHILD_RUN)).toEqual({ status: "failed", answer: null });
  });

  it("reports a Run that does not exist as failed", async () => {
    const { reader } = harness({});

    expect(await reader.read(BUSINESS, CHILD_RUN)).toEqual({ status: "failed", answer: null });
  });
});
