import { describe, expect, it, vi } from "vitest";
import { SoulWriteError } from "../writer";
import { parseSkillsLock, type SkillsLock, serializeSkillsLock } from "./lock";
import { mutateSkillsLock, type SkillsLockWriter, serializeSkillsLockWrites } from "./lock-write";

/**
 * A Soul whose lock lives in one string, so a test can model exactly what the real gateway
 * enforces: a commit is refused unless it was computed from the revision that is still current.
 */
function makeSoul(initial: SkillsLock = { version: 1, skills: {} }) {
  const state = { content: serializeSkillsLock(initial), revision: 0 };
  const applied: string[] = [];
  const writer: SkillsLockWriter = {
    readWithBase: async () => ({ content: state.content, baseCommit: String(state.revision) }),
    apply: async (request) => {
      if (request.expectedBaseCommit !== String(state.revision)) {
        throw new SoulWriteError("CONFLICT", "Soul write: the tree changed under this write");
      }
      const put = request.changes.find(
        (change) => change.op === "put" && change.target.kind === "SkillsLock"
      );
      if (put?.op === "put") state.content = put.content;
      state.revision += 1;
      applied.push(request.subject);
      return {
        commitSha: `sha-${state.revision}`,
        filesChanged: 1,
        paths: [],
        pushed: true,
        published: true,
      };
    },
  };
  const put = (lock: SkillsLock, subject: string) => ({
    subject,
    source: "api" as const,
    actor: { principalId: "service:test", name: "Test", email: "" },
    businessId: "test",
    changes: [
      {
        op: "put" as const,
        target: { kind: "SkillsLock" as const },
        content: serializeSkillsLock(lock),
      },
    ],
  });
  return { state, applied, writer, put, lock: () => parseSkillsLock(state.content) };
}

const entry = (version: string) => ({ sourceType: "curated" as const, version });

describe("mutateSkillsLock", () => {
  it("does not let one writer erase an entry another added at the same moment", async () => {
    const soul = makeSoul();
    const add = (name: string) =>
      mutateSkillsLock(soul.writer, "/soul", (lock) => {
        lock.skills[name] = entry("1.0.0");
        return soul.put(lock, `soul: install skill ${name}`);
      });

    await Promise.all([add("alpha"), add("beta")]);

    expect(Object.keys(soul.lock().skills).sort()).toEqual(["alpha", "beta"]);
  });

  it("recomputes against the current lock rather than retrying stale bytes", async () => {
    const soul = makeSoul();
    const seen: string[][] = [];
    // Land an unrelated entry between this writer's read and its commit.
    let interfered = false;
    const build = (lock: SkillsLock) => {
      seen.push(Object.keys(lock.skills).sort());
      lock.skills.mine = entry("1.0.0");
      return soul.put(lock, "soul: install skill mine");
    };
    const original = soul.writer.apply;
    soul.writer.apply = async (request) => {
      if (!interfered) {
        interfered = true;
        const theirs = parseSkillsLock(soul.state.content);
        theirs.skills.theirs = entry("1.0.0");
        soul.state.content = serializeSkillsLock(theirs);
        soul.state.revision += 1;
      }
      return original(request);
    };

    await mutateSkillsLock(soul.writer, "/soul", build);

    expect(seen).toEqual([[], ["theirs"]]);
    expect(Object.keys(soul.lock().skills).sort()).toEqual(["mine", "theirs"]);
  });

  it("gives up rather than looping forever on a Soul that keeps moving", async () => {
    const soul = makeSoul();
    soul.writer.apply = async () => {
      throw new SoulWriteError("CONFLICT", "Soul write: the tree changed under this write");
    };
    const build = vi.fn((lock: SkillsLock) => soul.put(lock, "soul: nope"));

    await expect(mutateSkillsLock(soul.writer, "/soul", build)).rejects.toThrow(SoulWriteError);
    expect(build).toHaveBeenCalledTimes(3);
  });

  it("commits nothing when the build decides there is no change", async () => {
    const soul = makeSoul();
    await expect(mutateSkillsLock(soul.writer, "/soul", () => null)).resolves.toBeNull();
    expect(soul.applied).toEqual([]);
  });

  it("surfaces a non-conflict failure without retrying it", async () => {
    const soul = makeSoul();
    soul.writer.apply = async () => {
      throw new SoulWriteError("COMMIT_FAILED", "disk on fire");
    };
    const build = vi.fn((lock: SkillsLock) => soul.put(lock, "soul: nope"));

    await expect(mutateSkillsLock(soul.writer, "/soul", build)).rejects.toThrow("disk on fire");
    expect(build).toHaveBeenCalledTimes(1);
  });
});

describe("serializeSkillsLockWrites", () => {
  it("runs writers for one Soul strictly one at a time", async () => {
    const order: string[] = [];
    const task = (id: string) => async () => {
      order.push(`${id}:start`);
      await new Promise((resolve) => setTimeout(resolve, 5));
      order.push(`${id}:end`);
    };

    await Promise.all([
      serializeSkillsLockWrites("/soul", task("a")),
      serializeSkillsLockWrites("/soul", task("b")),
    ]);

    expect(order).toEqual(["a:start", "a:end", "b:start", "b:end"]);
  });

  it("does not let one writer's failure cancel the writers queued behind it", async () => {
    const failing = serializeSkillsLockWrites("/soul-b", async () => {
      throw new Error("boom");
    });
    const following = serializeSkillsLockWrites("/soul-b", async () => "ran");

    await expect(failing).rejects.toThrow("boom");
    await expect(following).resolves.toBe("ran");
  });

  it("does not serialize unrelated Souls behind each other", async () => {
    let released = (): void => undefined;
    const blocker = serializeSkillsLockWrites(
      "/soul-c",
      () => new Promise<void>((resolve) => (released = resolve))
    );

    await expect(serializeSkillsLockWrites("/soul-d", async () => "free")).resolves.toBe("free");
    released();
    await blocker;
  });
});
