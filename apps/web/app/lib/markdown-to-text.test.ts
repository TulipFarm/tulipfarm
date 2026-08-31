import { describe, expect, it } from "vitest";
import { markdownLinksToPlainText } from "~/lib/markdown-to-text";

describe("markdownLinksToPlainText", () => {
  it("resolves a markdown link to its label", () => {
    expect(markdownLinksToPlainText("See [docs](https://example.com/docs).")).toBe("See docs.");
  });

  it("resolves multiple links in one string", () => {
    expect(markdownLinksToPlainText("[a](https://a.com) and [b](https://b.com)")).toBe("a and b");
  });

  it("strips angle-bracket autolinks to the bare URL", () => {
    expect(markdownLinksToPlainText("Reach us at <mailto:hi@example.com>")).toBe(
      "Reach us at mailto:hi@example.com"
    );
  });

  it("leaves plain text untouched", () => {
    expect(markdownLinksToPlainText("no links here")).toBe("no links here");
  });
});
