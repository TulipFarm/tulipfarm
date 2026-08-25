import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  collectTools,
  escapeCell,
  firstSentence,
  renderPage,
  toDocsWords,
} from "./generate-tool-docs";

function repoRoot(): string {
  let directory = __dirname;
  for (;;) {
    if (existsSync(join(directory, "pnpm-workspace.yaml"))) return directory;
    const parent = dirname(directory);
    if (parent === directory) throw new Error("pnpm-workspace.yaml not found");
    directory = parent;
  }
}

const ROOT = repoRoot();
const PAGE = join(ROOT, "apps/docs/content/docs/reference/tool-catalog.mdx");

describe("tool catalog page", () => {
  /**
   * The page is generated at docs build, so a stale committed copy still ships to anyone reading
   * the repo and still shows in a diff review as if a human wrote it. Regenerating and comparing is
   * the only thing that keeps the committed bytes honest between builds.
   */
  it("matches what the generator produces from the live registry", () => {
    expect(
      readFileSync(PAGE, "utf8"),
      "run `pnpm exec tsx scripts/generate-tool-docs.ts` and commit the result"
    ).toBe(renderPage(collectTools()));
  });

  it("covers the whole registry, so the comparison above is not vacuous", () => {
    const tools = collectTools();
    expect(tools.length).toBeGreaterThan(60);
    // Every section the page can render must actually have rows; an empty area means a family
    // silently stopped registering.
    for (const area of new Set(tools.map((tool) => tool.area))) {
      expect(tools.filter((tool) => tool.area === area).length).toBeGreaterThan(0);
    }
  });

  it("keeps integration and rendering Tools off the page", () => {
    const names = new Set(collectTools().map((tool) => tool.name));
    for (const excluded of ["present", "request_input", "update_presentation"]) {
      expect(names.has(excluded), `${excluded} belongs to the surfaces page`).toBe(false);
    }
    for (const name of names) {
      expect(name.startsWith("github_") || name.startsWith("slack_")).toBe(false);
    }
  });
});

describe("tool catalog rendering", () => {
  it("cuts a summary at the first real sentence", () => {
    expect(firstSentence("Do a thing. Then call this again.")).toBe("Do a thing.");
    expect(firstSentence("Do a thing")).toBe("Do a thing.");
    expect(firstSentence("Line one.\nLine two.")).toBe("Line one.");
  });

  it("does not end a sentence on an abbreviation", () => {
    expect(firstSentence("Fetch a page by path (e.g. 'policies/refunds') with no ranking.")).toBe(
      "Fetch a page by path (e.g. 'policies/refunds') with no ranking."
    );
  });

  it("neutralises the characters that would break a table row", () => {
    expect(escapeCell("a | b")).toBe("a \\| b");
    expect(escapeCell("under <slug>")).toBe("under &#60;slug&#62;");
    expect(escapeCell("pass {value}")).toBe("pass &#123;value&#125;");
  });

  it("swaps internal words for the ones the docs are allowed to use", () => {
    expect(toDocsWords("carried across every future conversation")).toBe(
      "carried across every future chat"
    );
    expect(toDocsWords("within the current routine execution context")).toBe(
      "within the current routine run context"
    );
  });

  it("never publishes a banned term lifted from a model-facing description", () => {
    const body = readFileSync(PAGE, "utf8");
    for (const banned of [/\bconversations?\b/i, /\bconnector\b/i, /\broutine execution\b/i]) {
      expect(banned.test(body), `${banned} is banned by metadata/terminologies.md`).toBe(false);
    }
  });
});
