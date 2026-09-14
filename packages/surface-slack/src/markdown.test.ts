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
});
