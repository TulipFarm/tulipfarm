import { describe, expect, it } from "vitest";
import { buildConceptResolver } from "./concept-href";
import type { BundlePageRef } from "./knowledge-api";
import {
  isSynthesizedIndex,
  listingToNodes,
  mergeEntries,
  parseListing,
  rewriteOkfLinks,
  rewriteWikiLinks,
} from "./okf-listing";

// One resolver for the rewriter tests: a handful of pages across the current bundle ("abc") and a
// cross-space bundle ("Sales"). conceptHref(id, path) → /knowledge/concepts/<id>/<last-path-segment>.
const PAGES: BundlePageRef[] = [
  { documentId: "doc-orders", bundleId: "abc", bundleName: "Eng", path: "orders", title: "Orders" },
  { documentId: "doc-tables", bundleId: "abc", bundleName: "Eng", path: "tables", title: "Tables" },
  { documentId: "doc-to", bundleId: "abc", bundleName: "Eng", path: "tables/orders", title: "O" },
  { documentId: "doc-cust", bundleId: "abc", bundleName: "Eng", path: "customers", title: "C" },
  { documentId: "doc-sub", bundleId: "abc", bundleName: "Eng", path: "sub", title: "Sub" },
  { documentId: "doc-rb", bundleId: "abc", bundleName: "Eng", path: "runbook", title: "Runbook" },
  { documentId: "doc-pricing", bundleId: "sid", bundleName: "Sales", path: "pricing", title: "P" },
];
const resolver = buildConceptResolver(PAGES);

describe("parseListing", () => {
  it("splits concepts (.md) and subdirectories (trailing slash)", () => {
    const md = ["* [Orders](orders.md)", "* [Tables](tables/)", "* [ext](https://x.com)"].join(
      "\n"
    );
    const entries = parseListing("", md);
    expect(entries).toEqual([
      { kind: "concept", label: "Orders", path: "orders" },
      { kind: "dir", label: "Tables", path: "tables" },
    ]);
  });

  it("resolves child paths relative to dirPath", () => {
    const entries = parseListing("tables", "* [Orders](orders.md)");
    expect(entries[0]).toEqual({ kind: "concept", label: "Orders", path: "tables/orders" });
  });
});

describe("mergeEntries (the page-with-children rule)", () => {
  it("merges a concept and a sibling dir of the same basename into one node", () => {
    const node = mergeEntries([
      { kind: "concept", label: "Engineering", path: "engineering" },
      { kind: "dir", label: "engineering", path: "engineering" },
    ]);
    expect(node).toEqual([
      { path: "engineering", label: "Engineering", hasBody: true, hasChildren: true },
    ]);
  });

  it("a concept-only entry is clickable but not expandable", () => {
    expect(mergeEntries([{ kind: "concept", label: "Runbook", path: "runbook" }])[0]).toMatchObject(
      {
        hasBody: true,
        hasChildren: false,
      }
    );
  });

  it("a dir-only entry is expandable but not clickable", () => {
    expect(mergeEntries([{ kind: "dir", label: "archive", path: "archive" }])[0]).toMatchObject({
      hasBody: false,
      hasChildren: true,
    });
  });

  it("preserves first-seen order", () => {
    const nodes = listingToNodes("", ["* [B](b.md)", "* [A](a/)", "* [A](a.md)"].join("\n"));
    expect(nodes.map((n) => n.path)).toEqual(["b", "a"]);
    expect(nodes[1]).toMatchObject({ path: "a", hasBody: true, hasChildren: true });
  });
});

describe("rewriteOkfLinks", () => {
  it("rewrites relative .md and dir links to stable concept UUID routes", () => {
    expect(rewriteOkfLinks("see [O](orders.md) and [T](tables/)", "abc", resolver)).toBe(
      "see [O](/knowledge/concepts/doc-orders/orders) and [T](/knowledge/concepts/doc-tables/tables)"
    );
  });
  it("leaves external, anchor, absolute, and unresolved (pure-dir) links untouched", () => {
    const md = "[x](https://a.com) [y](#sec) [z](/abs) [d](archive/)";
    expect(rewriteOkfLinks(md, "abc", resolver)).toBe(md);
  });
});

describe("rewriteWikiLinks", () => {
  it("rewrites tf:agent / tf:resource mention links to their views", () => {
    expect(rewriteWikiLinks("[deploy-bot](tf:agent/deploy-bot)", "abc", resolver)).toBe(
      "[deploy-bot](/agents/deploy-bot)"
    );
    expect(rewriteWikiLinks("[tickets](tf:resource/tickets)", "abc", resolver)).toBe(
      "[tickets](/resources/tickets)"
    );
  });

  it("rewrites a known cross-space tf:page link to the target concept's UUID route", () => {
    expect(rewriteWikiLinks("[Pricing](tf:page/Sales/pricing)", "abc", resolver)).toBe(
      "[Pricing](/knowledge/concepts/doc-pricing/pricing)"
    );
  });

  it("leaves an unknown cross-space tf:page link as a tf: href (rendered muted)", () => {
    expect(rewriteWikiLinks("[Ghost](tf:page/Unknown/x)", "abc", resolver)).toBe(
      "[Ghost](tf:page/Unknown/x)"
    );
  });

  it("rewrites same-space root-absolute, relative .md, and dir links", () => {
    expect(
      rewriteWikiLinks("[A](/tables/orders.md) [B](customers.md) [C](sub/)", "abc", resolver)
    ).toBe(
      "[A](/knowledge/concepts/doc-to/orders) [B](/knowledge/concepts/doc-cust/customers) [C](/knowledge/concepts/doc-sub/sub)"
    );
  });

  it("leaves external and anchor links untouched", () => {
    const md = "[x](https://a.com) [y](#sec)";
    expect(rewriteWikiLinks(md, "abc", resolver)).toBe(md);
  });

  it("does not rewrite image sources (![alt](src))", () => {
    expect(rewriteWikiLinks("![diagram](architecture.md)", "abc", resolver)).toBe(
      "![diagram](architecture.md)"
    );
    // A real link next to an image: only the link is rewritten.
    expect(rewriteWikiLinks("![d](pic.md) and [R](runbook.md)", "abc", resolver)).toBe(
      "![d](pic.md) and [R](/knowledge/concepts/doc-rb/runbook)"
    );
  });
});

describe("isSynthesizedIndex", () => {
  it("treats empty and reserved-heading listings as synthesized", () => {
    expect(isSynthesizedIndex("")).toBe(true);
    expect(isSynthesizedIndex("\n  \n")).toBe(true);
    expect(isSynthesizedIndex("# Concepts\n\n* [Orders](orders.md)")).toBe(true);
    expect(isSynthesizedIndex("# Subdirectories\n\n* [tables](tables/)")).toBe(true);
  });
  it("treats authored prose as NOT synthesized", () => {
    expect(isSynthesizedIndex("# Welcome\n\nThis is our wiki.")).toBe(false);
    expect(isSynthesizedIndex("Just some text")).toBe(false);
  });
});
