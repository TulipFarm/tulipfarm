import { describe, expect, it } from "vitest";
import { normalizeMarkdown, serializeDocToMarkdown } from "../markdown/markdown";
import { CALLOUT_KINDS } from "./callout";

describe("callout markdown round-trip", () => {
  for (const kind of CALLOUT_KINDS) {
    it(`[!${kind}] round-trips as a GitHub alert`, () => {
      const md = `> [!${kind}]\n> Body line.`;
      const once = normalizeMarkdown(md);
      expect(once).toContain(`> [!${kind}]`);
      expect(once).toContain("Body line.");
      expect(normalizeMarkdown(once)).toBe(once); // idempotent
    });
  }

  it("lowercase marker is normalized to uppercase", () => {
    const out = normalizeMarkdown("> [!note]\n> hi");
    expect(out).toContain("> [!NOTE]");
  });

  it("a plain blockquote is NOT turned into a callout", () => {
    const out = normalizeMarkdown("> just a quote");
    expect(out).toContain("> just a quote");
    expect(out).not.toContain("[!");
  });

  it("preserves rich inner content (bold + list) inside a callout", () => {
    const md = ["> [!WARNING]", "> Be **careful**:", "> ", "> - one", "> - two"].join("\n");
    const out = normalizeMarkdown(md);
    expect(out).toContain("> [!WARNING]");
    expect(out).toContain("**careful**");
    expect(out).toMatch(/>\s*[-*] one/);
    expect(normalizeMarkdown(out)).toBe(out);
  });

  it("unknown alert kind falls back gracefully (no callout, stays a quote)", () => {
    const out = normalizeMarkdown("> [!BOGUS]\n> hi");
    // BOGUS is not a known kind → the tokenizer ignores it → plain blockquote.
    expect(out).not.toContain("[!NOTE]");
    expect(out).toContain("hi");
  });

  it("an empty callout serializes to a bare marker and survives a reparse", () => {
    const doc = {
      type: "doc",
      content: [{ type: "callout", attrs: { kind: "NOTE" }, content: [{ type: "paragraph" }] }],
    };
    const md = serializeDocToMarkdown(doc);
    expect(md.trim()).toBe("> [!NOTE]"); // no bare `>` second line
    expect(normalizeMarkdown(md)).toContain("[!NOTE]"); // type not lost on round-trip
  });
});
