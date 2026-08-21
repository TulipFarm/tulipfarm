import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withGitSourceClone } from "./clone";
import { GitSourceError } from "./policy";

const publicResolver = async () => ["93.184.216.34"];

afterEach(() => {
  delete process.env.GIT_SOURCE_ALLOW_LOCAL_PATHS;
});

/** Stands in for the real `git`, so the assertion is about whether a process would start at all. */
function fakeGit(onClone?: (dir: string) => Promise<void>) {
  return vi.fn(async (args: readonly string[]) => {
    if (args[0] === "clone") {
      const dir = args.at(-1) ?? "";
      await mkdir(dir, { recursive: true });
      await onClone?.(dir);
      return "";
    }
    return "cafebabe\n";
  });
}

describe("withGitSourceClone", () => {
  const forbidden = [
    ["a local repository", "file:///srv/secrets/repo"],
    ["IPv4 loopback", "https://127.0.0.1/o/r.git"],
    ["IPv6 loopback", "https://[::1]/o/r.git"],
    ["the cloud metadata address", "https://169.254.169.254/o/r.git"],
    ["plain HTTP", "http://github.com/o/r.git"],
    ["credentials in the URL", "https://user:pass@github.com/o/r.git"],
    ["an unapproved host", "https://git.internal.example/o/r.git"],
  ] as const;

  it.each(forbidden)("starts no git process for %s", async (_label, source) => {
    const runGit = fakeGit();
    const use = vi.fn();
    await expect(
      withGitSourceClone(
        source,
        { prefix: "t-", actorId: "u1", runGit, resolve: publicResolver },
        use
      )
    ).rejects.toBeInstanceOf(GitSourceError);
    expect(runGit).not.toHaveBeenCalled();
    expect(use).not.toHaveBeenCalled();
  });

  it("clones an allowed source and removes the directory afterwards", async () => {
    const runGit = fakeGit();
    let cloned = "";
    const ref = await withGitSourceClone(
      "TulipFarm/skills",
      { prefix: "clone-ok-", actorId: "u1", runGit, resolve: publicResolver },
      async (clone) => {
        cloned = clone.dir;
        return clone.ref;
      }
    );
    expect(ref).toBe("cafebabe");
    expect(runGit.mock.calls[0][0]).toContain("--depth");
    await expect(import("node:fs/promises").then((fs) => fs.stat(cloned))).rejects.toThrow();
  });

  it("removes the directory when the caller's own work throws", async () => {
    const runGit = fakeGit();
    let cloned = "";
    await expect(
      withGitSourceClone(
        "TulipFarm/skills",
        { prefix: "clone-boom-", actorId: "u1", runGit, resolve: publicResolver },
        async (clone) => {
          cloned = clone.dir;
          throw new Error("scan blew up");
        }
      )
    ).rejects.toThrow("scan blew up");
    await expect(import("node:fs/promises").then((fs) => fs.stat(cloned))).rejects.toThrow();
  });

  it("reports a clone failure without any of git's output", async () => {
    const runGit = vi.fn(async () => {
      throw new Error("Command failed: git clone --depth 1 https://… /tmp/skill-scan-1gEQgo");
    });
    await expect(
      withGitSourceClone(
        "TulipFarm/skills",
        { prefix: "t-", actorId: "u1", runGit, resolve: publicResolver },
        async () => "unreachable"
      )
    ).rejects.toMatchObject({ denial: "clone_failed" });
  });

  it("refuses a second concurrent clone from the same actor", async () => {
    let releaseFirst: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      releaseFirst = () => resolve();
    });
    const runGit = fakeGit();
    const options = { prefix: "t-", actorId: "u1", runGit, resolve: publicResolver };
    const first = withGitSourceClone("TulipFarm/skills", options, async () => {
      await held;
      return "first";
    });
    await expect(
      withGitSourceClone("TulipFarm/skills", options, async () => "second")
    ).rejects.toMatchObject({ denial: "too_many_clones" });
    releaseFirst();
    expect(await first).toBe("first");
  });

  it("refuses once the global ceiling is reached, even across actors", async () => {
    let releaseFirst: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      releaseFirst = () => resolve();
    });
    const runGit = fakeGit();
    const limits = { maxConcurrent: 1 };
    const first = withGitSourceClone(
      "TulipFarm/skills",
      { prefix: "t-", actorId: "u1", runGit, resolve: publicResolver, limits },
      async () => {
        await held;
        return "first";
      }
    );
    await expect(
      withGitSourceClone(
        "TulipFarm/skills",
        { prefix: "t-", actorId: "u2", runGit, resolve: publicResolver, limits },
        async () => "second"
      )
    ).rejects.toMatchObject({ denial: "too_many_clones" });
    releaseFirst();
    expect(await first).toBe("first");
  });

  it("aborts a repository that grows past the byte limit", async () => {
    const runGit = vi.fn(async (args: readonly string[], options: { signal: AbortSignal }) => {
      if (args[0] !== "clone") return "cafebabe\n";
      const dir = args.at(-1) ?? "";
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "pack"), Buffer.alloc(4096));
      await new Promise<void>((resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(new Error("aborted")), {
          once: true,
        });
        setTimeout(resolve, 5_000);
      });
      return "";
    });
    await expect(
      withGitSourceClone(
        "TulipFarm/skills",
        {
          prefix: "t-big-",
          actorId: "u1",
          runGit,
          resolve: publicResolver,
          limits: { maxBytes: 1024 },
        },
        async () => "unreachable"
      )
    ).rejects.toMatchObject({ denial: "repository_too_large" });
  });

  it("releases the slot after a refusal so the actor is not locked out", async () => {
    const runGit = fakeGit();
    const options = { prefix: "t-", actorId: "u3", runGit, resolve: publicResolver };
    await expect(
      withGitSourceClone("https://127.0.0.1/o/r.git", options, async () => "x")
    ).rejects.toBeInstanceOf(GitSourceError);
    expect(await withGitSourceClone("TulipFarm/skills", options, async () => "ok")).toBe("ok");
  });
});
