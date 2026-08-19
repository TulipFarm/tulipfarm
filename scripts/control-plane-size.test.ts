import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The control plane may shrink. It may not grow.
 *
 * `apps/api` holds roughly as much code as all 24 packages combined, and the finding that named it
 * observed the same thing three editions running: 50,693 → 54,379 → 62,239. Every hardening wave
 * added to the application instead of pushing logic into the package that nominally owns it. The
 * inversion was never one bad decision; it was the absence of anything that noticed.
 *
 * Since this file was added the ceiling has come down three times, by moving domain logic to its
 * owning package rather than by reclassifying it: 59,706 → 58,948 (memory) → 54,529 (knowledge,
 * soul, and the shared SQL helpers that had kept the repositories stranded in the app) → 48,718
 * (the soul slice, landed alongside an independent wave that moved knowledge and the Tool host).
 * The mark is 49,214 rather than 48,718 because a foundation-model campaign added 496 lines to the
 * control plane between the measurement and this landing — the first growth the ratchet has caught.
 *
 * Raised again to 50,074 for the Task system: `tasks/routes.ts` is Fastify and belongs here, and
 * `tasks/tools.ts` follows the same handwritten-Tool exception as `tools/github/` and
 * `tools/slack/` — there is no owning package for bespoke, non-manifest platform Tools to move to.
 *
 * `apps/api` no longer holds the majority: the packages now carry 73,822 lines to its 49,214.
 *
 * The mark came down to 50,033 when the manifest egress transport moved to
 * `packages/integrations/src/egress`, where the `EgressHttpPort` it implements already lived. It
 * had been in the app for no reason other than that the app was where it was first needed. The
 * effect-plane wave that moved it also added `adapterFor()` to the declarative composition root,
 * which is Fastify-adjacent wiring and stays — so the net is 41 lines out, not 62.
 *
 * It came down again to 49,930 with the Memory Document backfill. The service reads
 * `memory_assertions` and writes documents through `MemoryDocumentRepo` and touches no Fastify, so
 * it lives in `packages/memory/src/document` beside the store it writes to; only its HTTP route
 * stayed here. This ratchet is what caught it — it was first written into the app purely because
 * that is where the route was.
 *
 * The Curator moved it twice in one wave, in both directions, and the pair is the point. It came
 * down to 49,671 when `host.ts` and `mint.ts` left for `packages/curator-host`, the Turn reader
 * for `packages/storage` and the Soul projection for `packages/curator` — none of them touch
 * Fastify. It then went back up 31 to 49,702 for the three internal routes those moves made
 * possible (`mint`, `reconcile`, `context`/`effects`) plus the composition that assembles them.
 * Routes are the one thing that genuinely has to be here. Net against the mark this wave started
 * from, the control plane is 228 lines smaller.
 *
 * The mark then moved to 49,811 on merging with #388-#390, whose authz role gate, thread mappings
 * and Routine retry work all added routes and wiring here. That is upstream growth, not the
 * Curator's: main's own ceiling for it was 50,033, so re-measuring the merged tree lowers the
 * ceiling by 222 rather than raising it. This is the re-baselining case — the number is measured
 * against the new merge-base, never widened to fit a diff.
 *
 * It moved to 49,816 for the first-run reconcile kick: `/setup/complete` now enqueues a reconcile
 * so a brand-new instance surfaces its setup gaps at minute 0 instead of up to fifteen minutes
 * later. That is a route side effect and has to be here. The wave paid most of its own way — the
 * kick-and-swallow block had been copied into three handlers, and collapsing it into
 * `kickTaskReconcile` gave back 24 of the 29 lines the feature cost.
 *
 * The mark then moved to 50,101 on merging with #391-#393, which lifted `AppOptions` into its own
 * `app-options.ts` and added the delegation, approval-evidence and sampler wiring the runtime
 * controls needed. All of it is upstream's, and all of it arrived through upstream's own review:
 * the merge-base measured 49,740, main measured 50,021, and this branch measured 49,816, so the
 * merged tree is the sum of two independently reviewed diffs rather than new growth. Re-baselining
 * against a new merge-base, as above, is not the same as widening an allowance to fit a diff.
 *
 * It moved to 50,116 for the wizard's soul reload. `/setup/business` wrote `soul.yaml` and never
 * refreshed the in-memory manifest, so the business name stayed empty until the API restarted —
 * reconcile signals could not see it, and Agents spoke with no business name. The fix is route
 * wiring by definition: a `SetupDeps` field, one composition line, and a `writeSoulConfig` helper
 * that both direct writes now share, so patch-commit-reload is a single path a future wizard step
 * cannot half-implement. That helper is what kept the cost to 15 lines rather than 28 — it
 * replaced two inline write blocks. There is no package this could move to; it exists only to
 * compensate for setup running before the SoulWriter gateway does. A follow-up added 3 more —
 * a `setupComplete` signal on the same internal route — after the reconciler was found opening a
 * Task for the business name while the wizard was still asking for it. Both are the same defect:
 * first-run setup is a second writer the rest of the system cannot see.
 *
 * It moved to 50,204 for the Curator's observability, and this is the largest single raise so far,
 * so it carries the most justification. The Curator applies model-derived effects to a user's
 * Memory; the rule is that it does not go live until an operator can see what it decided and why
 * it refused. That means mint outcomes and their skip reasons, settlement effect counts, the
 * validation rejection vocabulary, host denials, crash recovery, and backlog staleness. Three
 * quarters of the cost is Fastify by definition: the four internal routes are the only place the
 * API learns any of those outcomes, and each report has to be taken where the outcome is produced.
 * The reasoning itself did not move here — the observation shape is `CuratorObservedPayload` in
 * `packages/storage`, the loop's decisions stay in `@tulipfarm/curator-host`, and the routes only
 * name what already happened. What kept the cost down: reporting rides the existing domain-event
 * bus rather than threading a metrics sink through the request path, so no handler holds a sink
 * and a broken exporter cannot refuse a settlement; and `SERVICE_ERRORS`/`JOB_PARAMS` collapsed
 * schema fragments the four routes had been repeating, which paid back 13 of the lines.
 *
 * It moved to 50,377 for the shadow review surface, and the reason is that shadow mode was
 * write-only. The Curator has been recording what it *would* do into a ledger that applies to
 * nothing, and the cutover precondition says that output must be validated before the loop is
 * enabled — a claim nobody can make about a table only `psql` can read. `GET /api/v1/curator/shadow`
 * is the whole of that surface: one route, one response, counts plus the recent effects. 134 of the
 * 162 lines are that route and the schema the OpenAPI rule requires of it; the rest is its
 * `AppOptions` field and one registration. What did *not* land here: the reads are
 * `packages/storage/src/curator/review.ts`, and the disclosure policy — who may see a memory patch
 * in full — is `redactShadowEffect`/`projectShadowEffect` in the pure `packages/curator`, which is
 * where it can be tested against the payload shapes rather than through HTTP. The handler is three
 * lines because of that. It is registered in `app.ts` and deliberately not in the internal route
 * family: that family is service-only by contract, and one shared options field for both audiences
 * is exactly how a gate ends up applied to the wrong audience. The last 6 lines are the
 * `ADMIN_ONLY_SURFACES` entry, which that catalog's own comment requires of any new route gate, and
 * migration 64, which this directory owns by convention — the index the review read needs was
 * first written into migration 63's statement list, where no already-migrated database would ever
 * have seen it.
 *
 * Migration 65 is the next +42: converting `user_memory` from a section projection to the stored
 * Markdown page needs the old rows rendered before the column goes, and a data migration can only
 * live in the ledger that runs it. The rendering itself was pushed into `@tulipfarm/memory`, next
 * to the renderer whose vocabulary it depends on — what remains here is the ALTER sequence.
 *
 * `GET /api/v1/memory/document` is the next +69, and it is the smallest surface that can honestly
 * exist: a user cannot be told a hidden page decides how they are answered and then be given no way
 * to read it. 58 of those lines are the route file, most of them the response schema the OpenAPI
 * rule requires; the rest is one `AppOptions` field, one registration and one composition line.
 * There is no handler logic to move out — it reads one row and reports its length against the
 * budget. Deliberately absent: any write verb. Read-only is the contract, so there is no body
 * schema, no CSRF path and no authority check beyond "your own document".
 *
 * The assertion engine that `memory/routes.ts` served is deleted, and this edition of the ceiling
 * is 1,015 lines below the last: `memory/routes.ts`, the extraction service, the engine repository
 * and thirteen of their pg tests went with it.
 *
 * This is that. The ceiling is a high-water mark, not a target — lowering it as code moves out is
 * the point, and the only edit this file should ever receive. Raising it needs a reviewed reason,
 * because "the number went up again" is exactly the event three editions failed to catch.
 *
 * This edition raises it, from 49,492 to 51,107 measured against a 49,431 base. That is +1,676, and
 * it is the largest single raise the file has taken, so it is itemised:
 *
 *   +512  the Page and Space restriction surface itself — ten routes that read or set who may
 *         read a subject. Each answers 404 rather than 403, because the existence of a restricted
 *         Space is a disclosure, and each needs its own response schema under the OpenAPI rule.
 *   +277  `pg-migrations/index.ts`, five appended migrations. This directory owns the ledger by
 *         convention; see the `file-size` gate, which carries the same entry.
 *   +211  scaffolding from splitting `knowledge/routes.ts` four ways. The file had reached 1,053
 *         lines and crossed the 600-line `file-size` gate, so it became `routes.ts` plus
 *         `space-routes.ts`, `overview-routes.ts` and `restriction-routes.ts`. The 211 is entirely
 *         module headers, repeated imports and the dependency interface each split file needs to
 *         receive the closures it used to capture. No behaviour moved with it. The two gates pull
 *         against each other here and the file gate wins, because one 1,053-line file holding the
 *         whole ACL surface is the worse failure.
 *   +162  `knowledge/schemas.ts`, response schemas for those routes. Required, not optional: a
 *         route with no schema is absent from the generated OpenAPI document.
 *   +258  identity resolution at the route boundary — `subject-directory.ts` (+99),
 *         `reader-directory.ts` (+80), `author-label.ts` (+50), `denial-sink.ts` (+29).
 *   +115  `identity/external-links.ts` and `ingress/identity.ts`.
 *
 * None of the above is a candidate to move into `packages/knowledge`. The four route files hold
 * Fastify registrations, which is the one thing that has to live here. The identity files resolve a
 * principal to a display name and are the reason the boundary exists at all: `author-label.ts`
 * carries a comment saying so, and `denial-sink.ts` depends on this app's `AuditService`. Moving
 * them would push identity into a package that deliberately does not know about it, which is a
 * worse outcome than a higher number. The ACL logic they call is already in the package — 9,531
 * lines of it against 2,016 here, which is the ratio this gate exists to protect.
 *
 * Line count is a crude proxy for ownership, deliberately. A precise measure would need to model
 * what each domain ought to own, which is the argument the refactor itself has to settle; a crude
 * measure that cannot be gamed without noticing is worth more here than a subtle one.
 *
 * It moves to 51,117 for the Skill-package install fix, and the +10 is itemised because it is small
 * enough to be worth showing what stayed:
 *
 *   +3  `skillPath` on the scanned and marketplace response shapes, and its OpenAPI property. A
 *       Skill name is unique only within one directory, so a client had no stable key for a row and
 *       two same-named Skills collapsed into one selection.
 *   +6  two `reply.code(400)` guards on install — one naming the package files the Soul cannot
 *       store, one refusing a same-name selection the scan cannot disambiguate. Both exist so the
 *       operator is told which file or which package failed instead of receiving the write
 *       gateway's `invalid soul write target`.
 *   +1  one import.
 *
 * The decision behind the first guard — which files a layout can address — did not stay: it is
 * `unstorableArtifactPaths` in `packages/schema/src/artifacts.ts`, beside the registry that owns
 * the answer. Only the HTTP reply for it is here.
 */

const CEILING = 51_117;

/**
 * Domains inside `apps/api/src` that already have a package of the same name. Everything here that
 * does not touch Fastify is a candidate to move down; the counts are printed on failure so the next
 * person can see where the weight actually is rather than guessing.
 */
const DOMAINS_WITH_OWNING_PACKAGE = [
  "authz",
  "integrations",
  "knowledge",
  "memory",
  "soul",
] as const;

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

function sourceLines(absoluteDirectory: string): number {
  if (!existsSync(absoluteDirectory)) return 0;
  let total = 0;
  for (const entry of readdirSync(absoluteDirectory, { withFileTypes: true })) {
    const full = join(absoluteDirectory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      total += sourceLines(full);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
    if (entry.name.endsWith(".test.ts")) continue;
    const source = readFileSync(full, "utf8");
    const lines = source.split("\n");
    total += lines.at(-1) === "" ? lines.length - 1 : lines.length;
  }
  return total;
}

describe("the control plane may shrink, not grow", () => {
  it("keeps apps/api/src at or below its high-water mark", () => {
    const actual = sourceLines(join(ROOT, "apps/api/src"));

    const breakdown = DOMAINS_WITH_OWNING_PACKAGE.map((domain) => {
      const inApp = sourceLines(join(ROOT, "apps/api/src", domain));
      const inPackage = sourceLines(join(ROOT, "packages", domain, "src"));
      return `  ${domain.padEnd(14)} apps/api ${String(inApp).padStart(6)}   packages ${inPackage}`;
    }).join("\n");

    expect(
      actual,
      `apps/api/src is ${actual} lines, over its ${CEILING} ceiling by ${actual - CEILING}.\n\n` +
        "Put the new logic in the package that owns the domain, or move something out and lower\n" +
        "the ceiling in this file. Domains that already have an owning package:\n\n" +
        `${breakdown}\n\n` +
        "Only code that touches Fastify has to live in apps/api."
    ).toBeLessThanOrEqual(CEILING);
  });

  it("states a ceiling that is still meaningful", () => {
    const actual = sourceLines(join(ROOT, "apps/api/src"));
    expect(
      CEILING - actual,
      `The ceiling is ${CEILING - actual} lines above actual (${actual}). Lower CEILING to ${actual} ` +
        "so the slack cannot be spent without review."
    ).toBeLessThanOrEqual(2_000);
  });
});
