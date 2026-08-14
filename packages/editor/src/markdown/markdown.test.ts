import { describe, expect, it } from "vitest";
import { normalizeMarkdown, parseMarkdownToDoc } from "./markdown";

/*
 * Round-trip corpus asserts idempotent canonical markdown while allowing cosmetic serializer
 * normalization.
 */
const SAMPLES: Array<{ name: string; md: string; contains: RegExp }> = [
  { name: "h1", md: "# Title", contains: /^# Title/m },
  { name: "h2/h3", md: "## Sub\n\n### Deep", contains: /^### Deep/m },
  { name: "bold", md: "Some **bold** text.", contains: /\*\*bold\*\*/ },
  { name: "italic", md: "Some *italic* text.", contains: /[*_]italic[*_]/ },
  { name: "strike", md: "Some ~~gone~~ text.", contains: /~~gone~~/ },
  { name: "inline-code", md: "Use `npm i`.", contains: /`npm i`/ },
  { name: "link", md: "See [docs](https://x.com).", contains: /\[docs\]\(https:\/\/x\.com\)/ },
  {
    name: "same-space-page-link",
    md: "See [Customers](customers.md).",
    contains: /\[Customers\]\(customers\.md\)/,
  },
  {
    name: "cross-space-page-link",
    md: "See [Runbook](tf:page/Engineering/runbook).",
    contains: /\[Runbook\]\(tf:page\/Engineering\/runbook\)/,
  },
  {
    name: "agent-mention-link",
    md: "Ask [deploy-bot](tf:agent/deploy-bot).",
    contains: /\[deploy-bot\]\(tf:agent\/deploy-bot\)/,
  },
  {
    name: "resource-mention-link",
    md: "Log to [tickets](tf:resource/tickets).",
    contains: /\[tickets\]\(tf:resource\/tickets\)/,
  },
  { name: "bullet-list", md: "- one\n- two", contains: /^[-*] one/m },
  { name: "ordered-list", md: "1. one\n2. two", contains: /^1\. one/m },
  { name: "task-list", md: "- [ ] todo\n- [x] done", contains: /\[[ xX]\]/ },
  { name: "code-block", md: "```ts\nconst a = 1;\n```", contains: /```ts[\s\S]*const a = 1;/ },
  { name: "blockquote", md: "> quoted", contains: /^> quoted/m },
  { name: "divider", md: "a\n\n---\n\nb", contains: /^(---|\* \* \*|___|\*\*\*)/m },
  { name: "table", md: "| a | b |\n| --- | --- |\n| 1 | 2 |", contains: /\|\s*a\s*\|\s*b\s*\|/ },
];

describe("markdown bridge round-trip", () => {
  for (const s of SAMPLES) {
    it(`${s.name}: idempotent + preserves token`, () => {
      const once = normalizeMarkdown(s.md);
      const twice = normalizeMarkdown(once);
      expect(twice).toBe(once); // canonical form is stable
      expect(once).toMatch(s.contains); // construct survives the round-trip
    });
  }

  it("parse returns a doc node with content", () => {
    const doc = parseMarkdownToDoc("# Hi\n\ntext");
    expect(doc.type).toBe("doc");
    expect(Array.isArray(doc.content)).toBe(true);
    expect(doc.content?.length ?? 0).toBeGreaterThan(0);
  });

  it("serializes a combined document stably", () => {
    const md = ["# Title", "", "Intro **bold**.", "", "- a", "- b", "", "> note"].join("\n");
    const once = normalizeMarkdown(md);
    expect(normalizeMarkdown(once)).toBe(once);
    expect(once).toContain("# Title");
    expect(once).toContain("> note");
  });
});
