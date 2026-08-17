import type { CuratorJobRecord, CuratorRepo, StaleCuratorJob } from "@tulipfarm/storage";
import { beforeEach, describe, expect, it } from "vitest";
import type { CuratorMinter } from "./mint";
import { CuratorRecovery } from "./recovery";

const BUSINESS = "business-1";
const NOW = new Date("2026-01-01T01:00:00Z");

function job(id: string, overrides: Partial<CuratorJobRecord> = {}): CuratorJobRecord {
  return {
    id,
    businessId: BUSINESS,
    scope: "user",
    userId: "user-1",
    state: "minted",
    executionMode: "shadow",
    manifestDigest: "digest",
    manifest: { work: [], turnIds: [], candidateIds: [] },
    createdAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

class FakeRepo {
  stale: StaleCuratorJob[] = [];
  cutoffs: Date[] = [];

  async listStale(_businessId: string, cutoff: Date, _limit: number): Promise<StaleCuratorJob[]> {
    this.cutoffs.push(cutoff);
    return this.stale;
  }
}

class FakeMinter {
  recovered: string[] = [];
  abandoned: { jobId: string; state: string }[] = [];

  async recover(record: CuratorJobRecord): Promise<unknown> {
    this.recovered.push(record.id);
    return { outcome: "minted", jobId: record.id, runId: "run-1" };
  }
  async abandon(jobId: string, state: "cancelled" | "failed"): Promise<void> {
    this.abandoned.push({ jobId, state });
  }
}

describe("CuratorRecovery", () => {
  let repo: FakeRepo;
  let minter: FakeMinter;
  let recovery: CuratorRecovery;

  beforeEach(() => {
    repo = new FakeRepo();
    minter = new FakeMinter();
    recovery = new CuratorRecovery({
      repo: repo as unknown as CuratorRepo,
      minter: minter as unknown as CuratorMinter,
      unstartedGraceMs: 300_000,
      batchSize: 50,
      now: () => NOW,
    });
  });

  it("restarts a job that never reached the gateway, rather than minting a second one", async () => {
    repo.stale = [{ job: job("job-1"), disposition: "unstarted" }];
    expect(await recovery.run(BUSINESS)).toEqual({ recovered: 1, abandoned: 0 });
    expect(minter.recovered).toEqual(["job-1"]);
    expect(minter.abandoned).toEqual([]);
  });

  it("frees the target of a job whose Run died without answering", async () => {
    repo.stale = [{ job: job("job-2"), disposition: "abandoned" }];
    expect(await recovery.run(BUSINESS)).toEqual({ recovered: 0, abandoned: 1 });
    expect(minter.abandoned).toEqual([{ jobId: "job-2", state: "failed" }]);
  });

  it("only looks back past the grace window, so a mint still in flight is left alone", async () => {
    await recovery.run(BUSINESS);
    expect(repo.cutoffs).toEqual([new Date("2026-01-01T00:55:00Z")]);
  });

  it("does nothing when nothing is stuck", async () => {
    expect(await recovery.run(BUSINESS)).toEqual({ recovered: 0, abandoned: 0 });
  });
});
