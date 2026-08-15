import { describe, expect, it } from "vitest";
import {
  extractCrossPageLinks,
  extractLinks,
  parseOkf,
  resolveLink,
  rewriteCrossPageSpaceName,
} from "./parse";

describe("parseOkf", () => {
  it("parses standard frontmatter + body", () => {
    const c = parseOkf(
      `---\ntype: BigQuery Table\ntitle: Orders\ndescription: One row per order.\nresource: https://x/orders\ntags: [sales, orders]\ntimestamp: 2026-05-28T14:30:00Z\n---\n\n# Schema\n\nbody here`
    );
    expect(c).not.toBeNull();
    expect(c?.title).toBe("Orders");
    expect(c?.description).toBe("One row per order.");
    expect(c?.resource).toBe("https://x/orders");
    expect(c?.tags).toEqual(["sales", "orders"]);
    expect(c?.timestamp).toBe("2026-05-28T14:30:00Z");
    expect(c?.body).toBe("# Schema\n\nbody here");
  });

  it("is permissive — no required frontmatter (type-less and bare content still parse)", () => {
    expect(parseOkf("---\ntitle: No type\n---\n\nbody")?.title).toBe("No type");
    expect(parseOkf("no frontmatter at all")?.body).toBe("no frontmatter at all");
    expect(parseOkf("")).not.toBeNull();
  });

  it("extracts x-tf-* into tf and keeps them out of extra", () => {
    const c = parseOkf(
      `---\ntype: Playbook\nx-tf-domain: sales\nx-tf-always-load: true\nx-tf-source: resource\nx-tf-active: false\nx-tf-version: 3\n---\n\nbody`
    );
    expect(c?.tf).toEqual({
      domain: "sales",
      alwaysLoadForAgents: true,
      source: "resource",
      active: false,
      version: 3,
    });
    expect(c?.extra).toEqual({});
  });

  it("preserves unknown frontmatter keys in extra (round-trip)", () => {
    const c = parseOkf(`---\ntype: Metric\nconfidence: high\nowner: data-team\n---\n\nbody`);
    expect(c?.extra).toEqual({ confidence: "high", owner: "data-team" });
  });

  it("surfaces the `type` frontmatter field (excluded from extra)", () => {
    const c = parseOkf(`---\ntype: Metric\nowner: data-team\n---\n\nbody`);
    expect(c?.type).toBe("Metric");
    expect(c?.extra).toEqual({ owner: "data-team" });
    expect(parseOkf("---\ntitle: No type\n---\n\nbody")?.type).toBeNull();
  });

  it("tolerates a non-array tags value", () => {
    expect(parseOkf("---\ntype: X\ntags: nope\n---\n\nb")?.tags).toEqual([]);
  });
});

describe("extractLinks", () => {
  it("captures space-relative .md links, dedupes, and ignores external/anchor links", () => {
    const body = `See [a](/tables/orders.md) and [b](customers.md) and [a again](/tables/orders.md).
External [x](https://e.com/y.md), mail [m](mailto:a@b.md), anchor [h](#sec) ignored.
Parent [p](../refs/p.md).`;
    expect(extractLinks(body)).toEqual(["/tables/orders.md", "customers.md", "../refs/p.md"]);
  });
});

describe("extractCrossPageLinks", () => {
  it("captures tf:page/<Space>/<path> links, dedupes, and ignores agent/resource/.md links", () => {
    const body = `Cross [a](tf:page/Engineering/runbook) and nested [b](tf:page/Sales/tables/orders).
Dupe [a2](tf:page/Engineering/runbook). Agent [g](tf:agent/deploy-bot) and resource
[r](tf:resource/tickets) and same-space [s](customers.md) are NOT cross-page links.`;
    expect(extractCrossPageLinks(body)).toEqual([
      { spaceName: "Engineering", path: "runbook" },
      { spaceName: "Sales", path: "tables/orders" },
    ]);
  });

  it("strips a trailing .md and surrounding slashes from the target path", () => {
    expect(extractCrossPageLinks("[x](tf:page/Eng/runbook.md)")).toEqual([
      { spaceName: "Eng", path: "runbook" },
    ]);
  });
});

describe("rewriteCrossPageSpaceName", () => {
  it("rewrites the space segment of matching tf:page links, keeping the path", () => {
    const body = "See [a](tf:page/Sales/pricing) and nested [b](tf:page/Sales/tables/orders).";
    expect(rewriteCrossPageSpaceName(body, "Sales", "Revenue")).toBe(
      "See [a](tf:page/Revenue/pricing) and nested [b](tf:page/Revenue/tables/orders)."
    );
  });

  it("matches the decoded name and re-encodes the new name", () => {
    expect(
      rewriteCrossPageSpaceName("[x](tf:page/Data%20Eng/runbook)", "Data Eng", "Core Infra")
    ).toBe("[x](tf:page/Core%20Infra/runbook)");
  });

  it("leaves non-matching spaces and other tf: links untouched", () => {
    const body = "[a](tf:page/Sales/x) [b](tf:agent/bot) [c](tf:resource/tickets) [d](other.md)";
    expect(rewriteCrossPageSpaceName(body, "Engineering", "Core")).toBe(body);
  });
});

describe("resolveLink", () => {
  it("resolves absolute links from the space root", () => {
    expect(resolveLink("tables/orders", "/tables/customers.md")).toBe("tables/customers");
    expect(resolveLink("anything", "/a.md")).toBe("a");
  });

  it("resolves relative links from the source page's directory", () => {
    expect(resolveLink("tables/orders", "customers.md")).toBe("tables/customers");
    expect(resolveLink("tables/orders", "./customers.md")).toBe("tables/customers");
    expect(resolveLink("tables/orders", "../references/post_type_ids.md")).toBe(
      "references/post_type_ids"
    );
    expect(resolveLink("a/b/c", "../../x.md")).toBe("x");
  });
});
