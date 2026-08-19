import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * `KnowledgeServiceDeps.readership` is optional so the ~30 test fixtures that never ask a
 * readership question can skip it. The production composition is the one caller that must not:
 * without it `getPageVisibility` resolves `null`, and every Page-ACL surface degrades *silently*
 * rather than failing — `GET /pages/:id/visibility` answers 404, so the restrict dialog never
 * renders; `getPageScopes` answers an empty map, so every listing badge reads "business"; and a
 * move reports no readership change. The product then offers no way to restrict a Page at all,
 * while every unit and integration test stays green because each wires the dependency itself.
 *
 * A type cannot catch this without making the option mandatory for those 30 fixtures, and no unit
 * test can: the defect lives in the wiring, not the code under test. So this reads the composition
 * root as text. It is deliberately narrow — one claim about one object literal.
 */
describe("knowledge composition root", () => {
  const source = readFileSync(join(__dirname, "..", "index.ts"), "utf8");

  const depsLiteral = (): string => {
    const start = source.indexOf("new KnowledgeService({");
    expect(start, "new KnowledgeService({ in apps/api/src/index.ts").toBeGreaterThan(-1);
    const end = source.indexOf("\n    });", start);
    expect(end, "end of the KnowledgeService deps literal").toBeGreaterThan(start);
    return source.slice(start, end);
  };

  it("wires readership, without which no Page can be restricted through the product", () => {
    expect(depsLiteral()).toMatch(/\breadership:\s*new PgKnowledgeSubjectStore\(/);
  });

  it("wires the ACL repo the read gate shares", () => {
    expect(depsLiteral()).toMatch(/\bacl:\s*new PgKnowledgeAclRepo\(/);
  });

  /**
   * The same wiring hazard, one layer out. `knowledgeDenialSink` is optional so fixtures can skip
   * it, and omitting it changes no answer — refused writes simply stop being recorded. That is the
   * problem: authoring upserts by path, so a refusal tells a caller who may read the Space that the
   * path is taken. The bit cannot be removed, so detection is the whole countermeasure, and an
   * unwired sink deletes it silently while every test stays green.
   */
  const literalAfter = (needle: string): string => {
    const start = source.indexOf(needle);
    expect(start, `${needle} in apps/api/src/index.ts`).toBeGreaterThan(-1);
    const end = source.indexOf("\n    });", start);
    expect(end, `end of the ${needle} literal`).toBeGreaterThan(start);
    return source.slice(start, end);
  };

  it("builds the denial sink over the audit ledger", () => {
    expect(source).toMatch(/knowledgeDenialSink\s*=\s*makeKnowledgeDenialSink\(auditService\)/);
  });

  it("gives the denial sink to the Agent Tools, which are the main writers", () => {
    expect(literalAfter("buildToolRegistry({")).toMatch(/\bknowledgeDenialSink\b/);
  });

  it("gives the denial sink to the routes", () => {
    expect(literalAfter("await buildApp({")).toMatch(/\bknowledgeDenialSink\b/);
  });
});
