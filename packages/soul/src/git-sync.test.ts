import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("simple-git", () => ({ default: vi.fn() }));
vi.mock("node:fs", () => ({ existsSync: vi.fn() }));

import { existsSync } from "node:fs";
import simpleGit from "simple-git";
import { GitSyncService } from "./git-sync";

const mockExistsSync = vi.mocked(existsSync);
const mockSimpleGit = vi.mocked(simpleGit);

function makeMockGit(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    clone: vi.fn().mockResolvedValue(undefined),
    remote: vi.fn().mockResolvedValue(undefined),
    fetch: vi.fn().mockResolvedValue(undefined),
    raw: vi.fn().mockResolvedValue("0\t0"),
    reset: vi.fn().mockResolvedValue(undefined),
    pull: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function makeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

const REMOTE = "https://github.com/user/soul.git";
const SOUL = "/soul";

describe("GitSyncService", () => {
  let mockGit: ReturnType<typeof makeMockGit>;
  let logger: ReturnType<typeof makeLogger>;

  beforeEach(() => {
    mockGit = makeMockGit();
    // biome-ignore lint/suspicious/noExplicitAny: mock
    mockSimpleGit.mockReturnValue(mockGit as any);
    logger = makeLogger();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("bootSync — no remote", () => {
    it("skips all git ops in local-only mode", async () => {
      const svc = new GitSyncService(SOUL, undefined, undefined, logger);
      await svc.bootSync();
      expect(mockSimpleGit).not.toHaveBeenCalled();
      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("local-only"));
    });
  });

  describe("bootSync — first boot (clone)", () => {
    beforeEach(() => {
      mockExistsSync.mockReturnValue(false);
    });

    it("clones when .git does not exist", async () => {
      const svc = new GitSyncService(SOUL, REMOTE, undefined, logger);
      await svc.bootSync();
      expect(mockGit.clone).toHaveBeenCalledWith(REMOTE, SOUL);
    });

    it("injects credentials into clone URL", async () => {
      const svc = new GitSyncService(SOUL, REMOTE, "ghp_token", logger);
      await svc.bootSync();
      expect(mockGit.clone).toHaveBeenCalledWith(
        "https://ghp_token@github.com/user/soul.git",
        SOUL
      );
    });

    it("is non-fatal on clone failure", async () => {
      mockGit.clone.mockRejectedValue(new Error("network error"));
      const svc = new GitSyncService(SOUL, REMOTE, undefined, logger);
      await expect(svc.bootSync()).resolves.toBeUndefined();
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("network error"));
    });
  });

  describe("bootSync — subsequent boot (pull)", () => {
    beforeEach(() => {
      mockExistsSync.mockReturnValue(true);
    });

    it("runs pull when .git exists", async () => {
      mockGit.raw.mockResolvedValue("0\t3");
      const svc = new GitSyncService(SOUL, REMOTE, undefined, logger);
      await svc.bootSync();
      expect(mockGit.fetch).toHaveBeenCalledWith("origin", "main");
      expect(mockGit.pull).toHaveBeenCalledWith("origin", "main", ["--ff-only"]);
    });

    it("is non-fatal on pull failure", async () => {
      mockGit.fetch.mockRejectedValue(new Error("timeout"));
      const svc = new GitSyncService(SOUL, REMOTE, undefined, logger);
      await expect(svc.bootSync()).resolves.toBeUndefined();
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("timeout"));
    });
  });

  describe("divergence logic (SOUL-V1-004)", () => {
    beforeEach(() => {
      mockExistsSync.mockReturnValue(true);
    });

    it("no-op when fully in sync (ahead=0, behind=0)", async () => {
      mockGit.raw.mockResolvedValue("0\t0");
      const svc = new GitSyncService(SOUL, REMOTE, undefined, logger);
      await svc.bootSync();
      expect(mockGit.pull).not.toHaveBeenCalled();
      expect(mockGit.reset).not.toHaveBeenCalled();
    });

    it("keeps local and logs when ahead-only (un-pushed commits)", async () => {
      mockGit.raw.mockResolvedValue("3\t0");
      const svc = new GitSyncService(SOUL, REMOTE, undefined, logger);
      await svc.bootSync();
      expect(mockGit.pull).not.toHaveBeenCalled();
      expect(mockGit.reset).not.toHaveBeenCalled();
      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("ahead"));
    });

    it("fast-forwards when behind-only", async () => {
      mockGit.raw.mockResolvedValue("0\t5");
      const svc = new GitSyncService(SOUL, REMOTE, undefined, logger);
      await svc.bootSync();
      expect(mockGit.pull).toHaveBeenCalledWith("origin", "main", ["--ff-only"]);
      expect(mockGit.reset).not.toHaveBeenCalled();
    });

    it("hard-resets and logs discarded commits on genuine divergence", async () => {
      mockGit.raw
        .mockResolvedValueOnce("2\t3") // rev-list: 2 ahead, 3 behind
        .mockResolvedValueOnce("abc123 local commit\ndef456 another");
      const svc = new GitSyncService(SOUL, REMOTE, undefined, logger);
      await svc.bootSync();
      expect(mockGit.reset).toHaveBeenCalledWith(["--hard", "origin/main"]);
      expect(mockGit.pull).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("divergence"));
    });
  });

  describe("credentials safety", () => {
    it("does not log the token in any log call", async () => {
      mockExistsSync.mockReturnValue(false);
      mockGit.clone.mockRejectedValue(new Error("auth failed"));
      const svc = new GitSyncService(SOUL, REMOTE, "ghp_secret_token", logger);
      await svc.bootSync();
      const logged = [
        ...logger.info.mock.calls,
        ...logger.warn.mock.calls,
        ...logger.error.mock.calls,
      ]
        .flat()
        .join(" ");
      expect(logged).not.toContain("ghp_secret_token");
    });
  });

  describe("startPeriodicSync / stopPeriodicSync", () => {
    it("pulls on each interval tick", async () => {
      vi.useFakeTimers();
      mockExistsSync.mockReturnValue(true);
      mockGit.raw.mockResolvedValue("0\t1");
      const svc = new GitSyncService(SOUL, REMOTE, undefined, logger);
      svc.startPeriodicSync(300_000);
      await vi.advanceTimersByTimeAsync(300_000);
      expect(mockGit.fetch).toHaveBeenCalled();
      svc.stopPeriodicSync();
      vi.useRealTimers();
    });

    it("stops pulling after stopPeriodicSync", async () => {
      vi.useFakeTimers();
      mockExistsSync.mockReturnValue(true);
      mockGit.raw.mockResolvedValue("0\t0");
      const svc = new GitSyncService(SOUL, REMOTE, undefined, logger);
      svc.startPeriodicSync(300_000);
      svc.stopPeriodicSync();
      await vi.advanceTimersByTimeAsync(300_000);
      expect(mockGit.fetch).not.toHaveBeenCalled();
      vi.useRealTimers();
    });

    it("is non-fatal on periodic sync failure", async () => {
      vi.useFakeTimers();
      mockExistsSync.mockReturnValue(true);
      mockGit.fetch.mockRejectedValue(new Error("connection refused"));
      const svc = new GitSyncService(SOUL, REMOTE, undefined, logger);
      svc.startPeriodicSync(300_000);
      await vi.advanceTimersByTimeAsync(300_000);
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("connection refused"));
      svc.stopPeriodicSync();
      vi.useRealTimers();
    });
  });
});
