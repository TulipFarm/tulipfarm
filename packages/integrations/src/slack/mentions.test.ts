import { describe, expect, it } from "vitest";
import {
  encodeMentionsInText,
  resolveMentionsInText,
  type SlackMentionResolverPort,
  type SlackUserLookupPort,
} from "./mentions";

function resolverFrom(names: Record<string, string | undefined>): SlackMentionResolverPort {
  return {
    resolveDisplayName: async (userId: string) => names[userId],
  };
}

function lookupFrom(ids: Record<string, string | undefined>): SlackUserLookupPort {
  return {
    resolveUserId: async (name: string) => ids[name.toLowerCase()],
  };
}

describe("resolveMentionsInText", () => {
  it("replaces a single mention with the resolved display name", async () => {
    const result = await resolveMentionsInText(
      "create a task for <@U0AMFGRAKLY>",
      resolverFrom({ U0AMFGRAKLY: "Mohit" })
    );
    expect(result).toBe("create a task for @Mohit");
  });

  it("replaces multiple distinct mentions", async () => {
    const result = await resolveMentionsInText(
      "assign to <@U1> and cc <@U2>",
      resolverFrom({ U1: "Alice", U2: "Bob" })
    );
    expect(result).toBe("assign to @Alice and cc @Bob");
  });

  it("leaves an unresolved mention untouched", async () => {
    const result = await resolveMentionsInText(
      "task for <@U-UNKNOWN>",
      resolverFrom({ "U-UNKNOWN": undefined })
    );
    expect(result).toBe("task for <@U-UNKNOWN>");
  });

  it("handles the display-hint mention form <@ID|label>", async () => {
    const result = await resolveMentionsInText(
      "task for <@U0AMFGRAKLY|mohit>",
      resolverFrom({ U0AMFGRAKLY: "Mohit" })
    );
    expect(result).toBe("task for @Mohit");
  });

  it("is a no-op when there are no mentions", async () => {
    const result = await resolveMentionsInText("no mentions here", resolverFrom({}));
    expect(result).toBe("no mentions here");
  });
});

describe("encodeMentionsInText", () => {
  it("replaces a single plain @name with the resolved <@ID> token", async () => {
    const result = await encodeMentionsInText("hi @mohit", lookupFrom({ mohit: "U0AMFGRAKLY" }));
    expect(result).toBe("hi <@U0AMFGRAKLY>");
  });

  it("replaces multiple distinct @names", async () => {
    const result = await encodeMentionsInText(
      "hi @mohit and @shiv!",
      lookupFrom({ mohit: "U1", shiv: "U2" })
    );
    expect(result).toBe("hi <@U1> and <@U2>!");
  });

  it("matches case-insensitively", async () => {
    const result = await encodeMentionsInText("hi @Mohit", lookupFrom({ mohit: "U1" }));
    expect(result).toBe("hi <@U1>");
  });

  it("leaves an unresolved @name untouched", async () => {
    const result = await encodeMentionsInText("hi @unknown", lookupFrom({}));
    expect(result).toBe("hi @unknown");
  });

  it("is a no-op when there are no @names", async () => {
    const result = await encodeMentionsInText("no mentions here", lookupFrom({}));
    expect(result).toBe("no mentions here");
  });
});
