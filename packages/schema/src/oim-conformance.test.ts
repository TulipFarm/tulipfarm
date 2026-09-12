import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { oimConformanceIssues, parseOimManifest, validateOimConformanceClaim } from "./oim";

const FIXTURE_ROOT = join(import.meta.dirname, "../test/oim-conformance");

describe("OIM manifest conformance fixtures", () => {
  const files = readdirSync(join(FIXTURE_ROOT, "manifests")).sort();

  it("keeps at least one positive and negative fixture", () => {
    expect(files.some((file) => file.endsWith(".valid.yml"))).toBe(true);
    expect(files.some((file) => file.endsWith(".invalid.yml"))).toBe(true);
  });

  for (const file of files) {
    const source = readFileSync(join(FIXTURE_ROOT, "manifests", file), "utf8");
    if (file.endsWith(".valid.yml")) {
      it(`accepts ${file}`, () => {
        expect(parseOimManifest(source).kind).toBe("Integration");
      });
    } else {
      it(`rejects ${file}`, () => {
        expect(() => parseOimManifest(source)).toThrow();
      });
    }
  }
});

describe("OIM runtime conformance fixtures", () => {
  const files = readdirSync(join(FIXTURE_ROOT, "claims")).sort();

  for (const file of files) {
    const claim = validateOimConformanceClaim(
      JSON.parse(readFileSync(join(FIXTURE_ROOT, "claims", file), "utf8"))
    );
    if (file.endsWith(".valid.json")) {
      it(`accepts ${file}`, () => {
        expect(oimConformanceIssues(claim)).toEqual([]);
      });
    } else {
      it(`rejects ${file}`, () => {
        expect(oimConformanceIssues(claim).length).toBeGreaterThan(0);
      });
    }
  }
});
