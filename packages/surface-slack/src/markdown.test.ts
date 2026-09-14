import { describe, expect, it } from "vitest";
import { toSlackMrkdwn } from "./markdown";

describe("toSlackMrkdwn", () => {
  it("converts bold markers to single asterisks", () => {
    expect(toSlackMrkdwn("**Question 1 — cadence:**")).toBe("*Question 1 — cadence:*");
    expect(toSlackMrkdwn("__Question 1 — cadence:__")).toBe("*Question 1 — cadence:*");
  });

  it("leaves inline code and fenced code blocks untouched", () => {
    expect(toSlackMrkdwn("Use `**not bold**` here")).toBe("Use `**not bold**` here");
  });

  it("passes plain text through unchanged", () => {
    expect(toSlackMrkdwn("All systems green.")).toBe("All systems green.");
  });

  it("does not drop digits adjacent to bold text", () => {
    expect(toSlackMrkdwn("**Question 1 — cadence:** What default cadence?")).toBe(
      "*Question 1 — cadence:* What default cadence?"
    );
  });

  it("preserves pre-formatted Slack links and mentions", () => {
    expect(toSlackMrkdwn("<http://localhost:4000/runs/run-1|Quarterly review>")).toBe(
      "<http://localhost:4000/runs/run-1|Quarterly review>"
    );
    expect(toSlackMrkdwn("<http://localhost:4000/runs/run-1>")).toBe(
      "<http://localhost:4000/runs/run-1>"
    );
    expect(toSlackMrkdwn("<@U12345> and <#C12345|general>")).toBe(
      "<@U12345> and <#C12345|general>"
    );
    expect(toSlackMrkdwn("a < b & c > d")).toBe("a &lt; b &amp; c &gt; d");
  });
});
