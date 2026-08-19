import { existsSync, readFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseYamlDocument, validateRoutineDefinition } from "@tulipfarm/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  EVAL_SOUL_DIR,
  type EvalSoul,
  evalSoulHash,
  loadEvalSoul,
  SOUL_OWNED_CONTEXT_KEYS,
  soulContext,
} from "./eval-soul.ts";

let soul: EvalSoul;

beforeAll(async () => {
  soul = await loadEvalSoul();
});

afterAll(() => soul.dispose());

describe("loadEvalSoul", () => {
  it("reads the fixture with the real loader, quarantining nothing", async () => {
    expect(soul.loader.quarantined).toEqual([]);
    expect([...soul.loader.agents.keys()].sort()).toEqual([
      "finance",
      "records-readonly",
      "support",
      "triage",
    ]);
  });

  it("loads every artifact kind, so a Case can assert on any of them", async () => {
    expect(soul.loader.skills.has("refund-policy")).toBe(true);
    expect(soul.loader.resources.has("ticket")).toBe(true);
    expect(soul.loader.routines.has("daily-backlog-sweep")).toBe(true);
    expect(soul.loader.guardrailsConfig).not.toBeNull();
  });

  it("builds the catalogue with the real builder rather than by hand", async () => {
    expect(soul.catalogue.agents.map((a) => a.name)).toContain("triage");
    expect(soul.catalogue.skills.map((s) => s.name)).toContain("refund-policy");
  });

  it("materialises a real git repository, which the Soul writer requires", async () => {
    expect(existsSync(join(soul.path, ".git"))).toBe(true);
    expect(soul.path).not.toBe(EVAL_SOUL_DIR);
  });

  it("never hands out the tracked fixture itself, so a Sweep cannot dirty it", async () => {
    const tracked = readFileSync(join(EVAL_SOUL_DIR, "soul.yaml"), "utf8");

    expect(readFileSync(join(soul.path, "soul.yaml"), "utf8")).toBe(tracked);
  });

  it("removes its checkout on dispose, so a long Matrix does not fill the temp directory", async () => {
    const throwaway = await loadEvalSoul();
    expect(existsSync(throwaway.path)).toBe(true);

    throwaway.dispose();
    throwaway.dispose();

    expect(existsSync(throwaway.path)).toBe(false);
  });
});

describe("the fixture itself", () => {
  /**
   * `SoulLoader.loadRoutines` performs no validation, so an invalid Routine loads silently and
   * `quarantined` stays empty. Without this the fixture could ship a Routine no Run could ever
   * execute, and every assertion above would still pass.
   */
  it("defines a Routine the real validator accepts", async () => {
    const raw = await readFile(
      join(EVAL_SOUL_DIR, "routines", "daily-backlog-sweep", "routine.yaml"),
      "utf8"
    );

    expect(() => validateRoutineDefinition(parseYamlDocument(raw))).not.toThrow();
  });

  it("marks a Skill eager, so the eager path is measured and not merely empty", async () => {
    const names = await readdir(join(EVAL_SOUL_DIR, "skills"));

    expect(names).toContain("ticket-hygiene");
    expect(soulContext(soul, "support").eagerSkills?.map((s) => s.name)).toEqual([
      "ticket-hygiene",
    ]);
  });
});

describe("evalSoulHash", () => {
  it("is stable across reads, so an unchanged fixture never moves the Corpus version", async () => {
    expect(await evalSoulHash(EVAL_SOUL_DIR)).toBe(await evalSoulHash(EVAL_SOUL_DIR));
  });

  it("covers file contents and file names both", async () => {
    const hash = await evalSoulHash(EVAL_SOUL_DIR);

    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("soulContext", () => {
  it("takes the Agent's identity and body from the Soul, exactly as production does", async () => {
    const ctx = soulContext(soul, "triage");

    expect(ctx.agentId).toBe("triage");
    expect(ctx.domain).toBe("support");
    expect(ctx.personality).toContain("Never guess a status.");
  });

  it("takes the business from soul.yaml, so no Case restates it", async () => {
    const ctx = soulContext(soul, "support");

    expect(ctx.business?.name).toBe("Tulip Supply Co");
  });

  it("carries the catalogue and the Skill index the Soul defines", async () => {
    const ctx = soulContext(soul, "support");

    expect(ctx.soulCatalogue?.agents.length).toBe(4);
    expect(ctx.availableSkills?.map((s) => s.name)).toContain("refund-policy");
  });

  it("refuses an Agent the Eval Soul does not define", async () => {
    expect(() => soulContext(soul, "nonexistent")).toThrow(/nonexistent/);
    expect(() => soulContext(soul, "nonexistent")).toThrow(/support, triage/);
  });

  /**
   * A Case's context is spread over this one, so a field supplied here but absent from the
   * Corpus refusal list is a field a Case silently owns. That is how `tenantId` escaped.
   */
  it("supplies exactly the fields the Corpus refuses a Case from setting", async () => {
    const supplied = Object.keys(soulContext(soul, "support")).sort();

    expect(supplied).toEqual([...SOUL_OWNED_CONTEXT_KEYS].sort());
  });

  it("carries the eager Skill body production would render", async () => {
    const eager = soulContext(soul, "support").eagerSkills ?? [];

    expect(eager.map((s) => s.name)).toContain("ticket-hygiene");
    expect(eager[0]?.body).toContain("Do not use bullet lists");
  });
});
