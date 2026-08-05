import { describe, expect, it } from "vitest";
import { toSlackMrkdwn } from "./markdown";

describe("toSlackMrkdwn", () => {
  it("converts bold markers to single asterisks", () => {
    expect(toSlackMrkdwn("**Everyday Business Work**")).toBe("*Everyday Business Work*");
    expect(toSlackMrkdwn("__Everyday Business Work__")).toBe("*Everyday Business Work*");
  });

  it("converts markdown links to Slack link syntax", () => {
    expect(toSlackMrkdwn("[TulipFarm](https://tulipfarm.dev)")).toBe(
      "<https://tulipfarm.dev|TulipFarm>"
    );
  });

  it("converts bullet list markers to bullet points", () => {
    expect(toSlackMrkdwn("- Manage Data\n* Research")).toBe("• Manage Data\n• Research");
  });

  it("converts headers to bold text", () => {
    expect(toSlackMrkdwn("## Everyday Business Work")).toBe("*Everyday Business Work*");
  });

  it("converts strikethrough to single tildes", () => {
    expect(toSlackMrkdwn("~~done~~")).toBe("~done~");
  });

  it("escapes Slack special characters outside code spans", () => {
    expect(toSlackMrkdwn("a < b & c > d")).toBe("a &lt; b &amp; c &gt; d");
  });

  it("leaves inline code and fenced code blocks untouched", () => {
    expect(toSlackMrkdwn("Use `**not bold**` here")).toBe("Use `**not bold**` here");
    expect(toSlackMrkdwn("```\n**not bold**\n```")).toBe("```\n**not bold**\n```");
  });

  it("passes plain text through unchanged", () => {
    expect(toSlackMrkdwn("All systems green.")).toBe("All systems green.");
  });
});
