import { describe, expect, it } from "vitest";
import { resolveMentionsInText, type SlackMentionResolverPort } from "./mentions";

function resolverFrom(names: Record<string, string | undefined>): SlackMentionResolverPort {
  return {
    resolveDisplayName: async (userId: string) => names[userId],
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
