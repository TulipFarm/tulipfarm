import { describe, expect, it } from "vitest";
import {
  indexEmojiDirectory,
  normalizeEmojiName,
  resolveEmojiName,
  SlackEmojiDirectory,
  type SlackEmojiDirectoryPort,
} from "./emoji";

const DIRECTORY: Record<string, string> = {
  thumbsup: "https://emoji.slack-edge.com/thumbsup.png",
  white_check_mark: "https://emoji.slack-edge.com/check.png",
  "party-parrot": "https://emoji.slack-edge.com/parrot.gif",
  "+1": "alias:thumbsup",
  tada: "https://emoji.slack-edge.com/tada.png",
};

describe("normalizeEmojiName", () => {
  it("folds colons, case, and the separators the same emoji is written with", () => {
    expect(normalizeEmojiName(":White_Check-Mark:")).toBe("whitecheckmark");
    expect(normalizeEmojiName("party parrot")).toBe("partyparrot");
  });
});

describe("indexEmojiDirectory", () => {
  it("resolves an alias to the name Slack accepts", () => {
    const index = indexEmojiDirectory(DIRECTORY);
    expect(index.byNormalized.get("+1")).toBe("thumbsup");
  });

  it("does not let an alias displace the name it points at", () => {
    const index = indexEmojiDirectory({ heart: "u.png", hearts: "alias:heart" });
    expect(index.byNormalized.get("heart")).toBe("heart");
  });
});

describe("resolveEmojiName", () => {
  it("matches an exact name", () => {
    expect(resolveEmojiName("tada", DIRECTORY)).toEqual({ outcome: "resolved", name: "tada" });
  });

  it("matches across separator spellings", () => {
    expect(resolveEmojiName("thumbs_up", DIRECTORY)).toEqual({
      outcome: "resolved",
      name: "thumbsup",
    });
  });

  it("matches a unique substring", () => {
    expect(resolveEmojiName("parrot", DIRECTORY)).toEqual({
      outcome: "resolved",
      name: "party-parrot",
    });
  });

  it("matches a near miss by edit distance", () => {
    expect(resolveEmojiName("tadaa", DIRECTORY)).toEqual({ outcome: "resolved", name: "tada" });
  });

  it("reports unknown rather than guessing at a name nothing resembles", () => {
    const result = resolveEmojiName("zzzzzzzzqqqq", DIRECTORY);
    expect(result.outcome).toBe("unknown");
  });

  it("reports unknown for an empty request", () => {
    expect(resolveEmojiName("::", DIRECTORY)).toEqual({ outcome: "unknown", candidates: [] });
  });
});

function countingPort(directories: Record<string, string>[]): {
  port: SlackEmojiDirectoryPort;
  calls: () => number;
} {
  let calls = 0;
  return {
    port: {
      async load() {
        const value = directories[Math.min(calls, directories.length - 1)];
        calls += 1;
        return value;
      },
    },
    calls: () => calls,
  };
}

describe("SlackEmojiDirectory", () => {
  it("loads once and serves later hits from cache", async () => {
    const { port, calls } = countingPort([DIRECTORY]);
    const directory = new SlackEmojiDirectory(port);

    await directory.resolve("tada");
    await directory.resolve("thumbsup");

    expect(calls()).toBe(1);
  });

  it("refetches on a miss so an emoji added minutes ago still resolves", async () => {
    const { port, calls } = countingPort([{ tada: "a.png" }, { tada: "a.png", newbie: "b.png" }]);
    const directory = new SlackEmojiDirectory(port, { minRefreshIntervalMs: 0 });

    expect(await directory.resolve("newbie")).toEqual({ outcome: "resolved", name: "newbie" });
    expect(calls()).toBe(2);
  });

  it("does not refetch twice for misses inside the refresh floor", async () => {
    let now = 1_000;
    const { port, calls } = countingPort([{ tada: "a.png" }]);
    const directory = new SlackEmojiDirectory(port, {
      minRefreshIntervalMs: 60_000,
      now: () => now,
    });

    await directory.resolve("zzzzzzzz");
    now += 100;
    await directory.resolve("qqqqqqqq");

    expect(calls()).toBe(1);
  });

  it("reloads after the ttl expires", async () => {
    let now = 0;
    const { port, calls } = countingPort([DIRECTORY]);
    const directory = new SlackEmojiDirectory(port, { ttlMs: 1_000, now: () => now });

    await directory.resolve("tada");
    now = 2_000;
    await directory.resolve("tada");

    expect(calls()).toBe(2);
  });

  it("degrades to an empty directory when the load fails", async () => {
    const directory = new SlackEmojiDirectory({
      async load() {
        throw new Error("slack down");
      },
    });

    expect(await directory.resolve("tada")).toEqual({ outcome: "unknown", candidates: [] });
  });
});
