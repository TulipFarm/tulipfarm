import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Fitness function: `priceCall` in `packages/llm/src/pricing.ts` is the only authority on what a
 * model call cost.
 *
 * The rule exists because it has already been broken three ways at once. The Worker branch that
 * charges the Run budget and the API branch that reports spend each priced calls their own way, so
 * the operator's `pricing_overrides` corrected the report and left enforcement on the uncorrected
 * price. A subscription seat — genuinely unmetered — was charged published API rates because the
 * pricing entry point could not see which provider served the call. And a model no table priced
 * was reported as costing nothing, so a declared cost ceiling silently did not apply to it.
 *
 * A previous attempt at this fix relocated the divergence rather than removing it. So this test
 * checks the shape that makes divergence possible, not the symptom:
 *
 *   1. Nobody multiplies a token count by a price outside the authority.
 *   2. Every caller passes `provider`, so a subscription seat can never be mistaken for a
 *      price-map miss. (`PriceCallInput.provider` is required, so the compiler enforces this too —
 *      this test catches a future weakening of that type.)
 *   3. `unpriced` is never collapsed into a zero cost.
 */

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

/** The authority's own implementation and its tests are the one place allowed to do arithmetic. */
const AUTHORITY = "packages/llm/src/pricing.ts";

const SCANNED_ROOTS = [
  "apps/api/src",
  "apps/worker/src",
  "apps/integration-worker/src",
  "packages/llm/src",
  "packages/agent-runtime/src",
  "packages/run-kernel/src",
];

function sourceFiles(): string[] {
  const found: string[] = [];
  for (const root of SCANNED_ROOTS) {
    const absolute = join(ROOT, root);
    if (!existsSync(absolute)) continue;
    walk(absolute, found);
  }
  return found.filter((file) => !file.endsWith(".test.ts") && relative(ROOT, file) !== AUTHORITY);
}

function walk(directory: string, into: string[]): void {
  for (const entry of readdirSync(directory)) {
    const full = join(directory, entry);
    if (statSync(full).isDirectory()) {
      if (entry !== "node_modules" && entry !== "dist") walk(full, into);
      continue;
    }
    if (full.endsWith(".ts") || full.endsWith(".tsx")) into.push(full);
  }
}

describe("one pricing authority", () => {
  it("is the only place that turns token counts into money", () => {
    // A per-1M price divided or multiplied by a token count, anywhere but the authority. Two of
    // these is how the overrides came to reach only one of the two branches that needed them.
    const arithmetic = /(tokens?(In|Out|_in|_out)|inputTokens|outputTokens)\s*[*/]\s*1_?000_?000/i;
    const perToken = /cost(In|Out)PerToken\s*\*/i;

    const offenders = sourceFiles().filter((file) => {
      const text = readFileSync(file, "utf8");
      return arithmetic.test(text) || perToken.test(text);
    });

    expect(
      offenders.map((file) => relative(ROOT, file)),
      `Price a call through \`priceCall\` from @tulipfarm/llm instead of computing cost here. ` +
        `A second pricing site is how an operator override came to reach reporting but not the ` +
        `budget that enforces spend.`
    ).toEqual([]);
  });

  it("never lets a caller reach the authority without naming the provider", () => {
    // `provider` is how a subscription seat is recognised. Without it the seat looks exactly like
    // an ordinary model missing from the price table, and gets billed at full published rates.
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      const text = readFileSync(file, "utf8");
      for (const call of text.matchAll(/\b(priceCall|isPriceable)\s*\(\s*\{/g)) {
        const body = balancedArgument(text, call.index + call[0].length - 1);
        if (body !== undefined && !/\bprovider\s*:/.test(body) && !/\.\.\./.test(body)) {
          offenders.push(`${relative(ROOT, file)} — ${call[1]}`);
        }
      }
    }
    expect(offenders, "Pass `provider` so a subscription seat is not billed API rates.").toEqual(
      []
    );
  });

  it("keeps the required `provider` field on the pricing input", () => {
    const authority = readFileSync(join(ROOT, AUTHORITY), "utf8");
    // Not optional (`provider?:`) — the compiler is the first line of this defence.
    expect(authority).toMatch(/readonly provider:\s*string;/);
    expect(authority).not.toMatch(/readonly provider\?:/);
  });

  it("keeps `subscription` and `unpriced` as distinct outcomes", () => {
    const authority = readFileSync(join(ROOT, AUTHORITY), "utf8");
    // A seat costs a known zero; an unpriceable model costs an unknown amount. Collapsing them
    // into "no cost" is what let an unpriceable model run under a ceiling it could never trip.
    expect(authority).toMatch(/kind:\s*"subscription"/);
    expect(authority).toMatch(/kind:\s*"unpriced"/);
  });

  it("never reports an unpriced call as costing zero", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      const text = readFileSync(file, "utf8");
      // e.g. `costUsd: cost.kind === "unpriced" ? 0 : ...` or `?? 0` on a cost that may be absent.
      if (/unpriced"\s*\?\s*0\b/.test(text) || /costUsd\s*\?\?\s*0\b/.test(text)) {
        offenders.push(relative(ROOT, file));
      }
    }
    expect(
      offenders,
      "An unpriced call has an unknown cost, not a zero one. Omit the cost and record the basis."
    ).toEqual([]);
  });
});

/** Returns the text inside the braces starting at `open`, or `undefined` when unbalanced. */
function balancedArgument(text: string, open: number): string | undefined {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") {
      depth--;
      if (depth === 0) return text.slice(open + 1, i);
    }
  }
  return undefined;
}
