import { describe, expect, it } from "vitest";
import {
  hashResumeToken,
  mintResumeToken,
  RunResumeGateway,
  type RunResumeStore,
  resumeTokenHashEquals,
} from "./resume";

describe("resume tokens", () => {
  it("mints unguessable, unique tokens with a matching digest", () => {
    const minted = Array.from({ length: 64 }, () => mintResumeToken());

    for (const { token, tokenHash } of minted) {
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(tokenHash).toBe(hashResumeToken(token));
      expect(tokenHash).not.toContain(token);
    }
    expect(new Set(minted.map((entry) => entry.token)).size).toBe(minted.length);
  });

  it("compares digests without leaking length mismatches as a throw", () => {
    const { tokenHash } = mintResumeToken();

    expect(resumeTokenHashEquals(tokenHash, tokenHash)).toBe(true);
    expect(resumeTokenHashEquals(tokenHash, "short")).toBe(false);
  });
});

describe("RunResumeGateway", () => {
  it("requeues a waiting Run once and reports a Run that already moved", async () => {
    const calls: string[] = [];
    const waiting = new Set(["business-1:run-1"]);
    const store: RunResumeStore = {
      async requeueWaitingRun(businessId, runId) {
        calls.push(`${businessId}:${runId}`);
        return waiting.delete(`${businessId}:${runId}`);
      },
    };
    const gateway = new RunResumeGateway(store);

    expect(await gateway.resume("business-1", "run-1")).toBe(true);
    expect(await gateway.resume("business-1", "run-1")).toBe(false);
    expect(calls).toHaveLength(2);
  });
});
