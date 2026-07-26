import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "..");
const DOCS = "apps/docs/content/docs";
const PAGES = [
  `${DOCS}/security/control-evidence.mdx`,
  `${DOCS}/security/privacy.mdx`,
  `${DOCS}/guides/operations.mdx`,
  `${DOCS}/guides/incidents.mdx`,
] as const;

function page(path: string): string {
  return readFileSync(resolve(ROOT, path), "utf8");
}

describe("compliance and operator evidence documentation", () => {
  it("ships every control and operator page", () => {
    for (const path of PAGES) expect(existsSync(resolve(ROOT, path)), path).toBe(true);
  });

  it("maps control families without making certification claims", () => {
    const controls = page(PAGES[0]);
    for (const framework of [
      "SOC 2",
      "ISO 27001",
      "GDPR",
      "DPDP Act",
      "NIST AI RMF",
      "OWASP ASVS",
      "OWASP LLM",
    ]) {
      expect(controls, framework).toContain(framework);
    }
    for (const distinction of [
      "Product feature",
      "Configuration",
      "Operator duty",
      "Independent certification",
    ]) {
      expect(controls).toContain(distinction);
    }
    expect(controls).not.toMatch(/TulipFarm is (?:certified|compliant)/i);
  });

  it("documents retention, access review, incident, export, erase, and denial duties", () => {
    const combined = PAGES.slice(1).map(page).join("\n");
    for (const required of [
      "retention",
      "access review",
      "incident",
      "export",
      "erase",
      "denied-access",
    ]) {
      expect(combined.toLowerCase(), required).toContain(required);
    }
  });

  it("links examples to existing code or executable evidence", () => {
    const combined = PAGES.map(page).join("\n");
    const evidencePaths = [...combined.matchAll(/Evidence: `([^`]+)`/g)].map((match) => match[1]);
    expect(evidencePaths.length).toBeGreaterThanOrEqual(8);
    for (const path of evidencePaths) {
      expect(existsSync(resolve(ROOT, path)), path).toBe(true);
    }
  });
});
