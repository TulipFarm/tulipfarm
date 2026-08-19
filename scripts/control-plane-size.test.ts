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
 * Message content became an ordered list of parts, and that is the next +7: four files in
 * `apps/api/src` now import `@tulipfarm/schema` to build, flatten or collapse them, and the
 * message repo carries two pg tests pinning that a text-only row still reaches the Chat wire as a
 * string. The logic itself —
 * the part union, the legacy-row normaliser, the text projection — lives in `@tulipfarm/schema`,
 * so what landed here is three import statements and no new branch.
 *
 * File upload is the next +269, and it is the largest single raise this file has taken. What
 * landed: `files/routes.ts` (four routes, most of it the response schemas the OpenAPI rule
 * requires, plus the raw-stream content-type parsers, which are Fastify by definition) and its
 * 13 pg tests, which boot the real app and speak real HTTP because the things they pin — a
 * refused media type, a 413 on a declared length, one Principal being unable to read another's
 * File — are only observable through the stack. Migration 68 lives here by the same convention as
 * 64 and 65.
 *
 * What did *not* land here, and the extraction is the reason this number is 269 and not 374: the
 * whole of `@tulipfarm/files` — the limits, the magic-byte sniffer, the filename normaliser, the
 * repository and the ordered upload pipeline. Two further pieces were moved out after this ratchet
 * caught them, both first written into the app purely because the route was: `files/http.ts` (the
 * File wire shape, the `FileError`-to-status table, the RFC-5987 disposition and the download
 * headers — all facts about Files, none about Fastify) and `files/attachments.ts`, which resolves
 * the file ids a Chat request claims against the caller's authority and touches no HTTP at all.
 *
 * The review of that slice added the last 117, all of it schema and the tests that pin it: the
 * `file` variant on the Message response schema, without which fast-json-stringify failed the
 * whole page and one attachment made a Conversation unloadable, plus three route tests — the
 * serializer round trip that caught it, an attachment-only Message, and the proof that a refused
 * attachment leaves neither a Turn nor an empty Conversation behind.
 *
 * Sending an attachment to the model is the next +35, and the number is 35 because this ratchet
 * rejected the first attempt at 101. What landed is only what Fastify forces: the internal route
 * that streams one Turn's File to the Worker — bytes cannot ride inside the JSON Context response,
 * so a second endpoint is the only way — its params schema, the `attachments` manifest on the
 * Context response schema (undeclared properties are stripped on serialization, so an omitted key
 * would silently drop the File between API and Worker), and the composition that wires the File
 * service into both.
 *
 * What moved out instead, and is the whole difference: `@tulipfarm/files/turn-attachments.ts`,
 * holding both halves of the rule — which Files a Turn may send, re-authorized rather than
 * trusted and scoped to the Turn by `turnId`, and the two-gate byte read that answers `null`
 * identically for "never attached" and "no longer authorized". Both were first written into the
 * app for no better reason than that the route was, and keeping them together matters beyond
 * ownership: the manifest the Context carries and the bytes the Worker later fetches have to
 * agree about which Files a Turn attached, and two copies of that rule would be free to drift.
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
 * Ticket 05 raised it again, to 49_943, for the same shape of reason. Refusing an attachment at
 * routing time is correct but late: the person has already chosen the file and written a prompt
 * around it. So a Turn's composer needs to know, before any of that, whether some configured model
 * could read the thing at all — which is a route (`GET /api/v1/files/accepted-modalities`), its
 * response schema, and the composition that supplies it. All three are Fastify and can live
 * nowhere else. The judgement they expose is not: `acceptedInputModalities` is in
 * `@tulipfarm/schema` beside `modalitiesFor`, the one place that already decides what a pinned
 * spec implies about modality, so the answer the composer acts on and the answer routing enforces
 * are derived from the same rule rather than two that could disagree.
 *
 * That growth was paid for in the same change: the hand-written `ModelSpecRouteSchema` in
 * `soul/llm-config/routes.ts` was a copy of `ModelSpecSchema` maintained by hand, and adding
 * `supports_pdf_input` to both is what exposed it. It now imports the real schema, which is 21
 * lines smaller and, more to the point, cannot drift from the contract again.
 *
 * It then moved to 51,149 for the Agent autonomy ceiling. The rule itself did not land here — the
 * ladder, the min and the approval predicate are 47 lines in `packages/tool-host/src/autonomy.ts`,
 * which is where every host already reads its gate from. What stayed is the +42 of per-path wiring
 * that has no owning package: `delivery-host.ts` resolving a Channel thread's Conversation to its
 * Agent (`ConversationRepo` and `SoulLoader` are both this app's), the ingress binding's refusal in
 * `bindings.ts`, and the `autonomy` field on the resolver that turns a Soul Agent into a
 * `HostedAgent` — a file whose own comment already records why it cannot move. The wave paid back
 * 7 lines by collapsing the approval predicate `tool-adapter.ts` kept its own copy of onto the
 * shared one, which is also why the raise is 42 rather than 49.
 *
 * Raised again, 49_943 -> 49_973, for the Files library listing: the route gained a cursor
 * querystring, a `nextCursor` on the response, a 400 for a cursor this instance did not issue, and
 * a provenance call after a chat submit. The paging itself is *not* here — reading one row past the
 * page and encoding the resume key are facts about listing Files, so they live in
 * `FileService.listPage`, and the route only translates them. What remains is schema and wiring,
 * which is the one thing apps/api is for.
 *
 * Raised again, 49_973 -> 50_160, for File sharing: four routes (share, revoke, list shares, and
 * a "shared with me" listing), each carrying the full OpenAPI schema every route here owes. None of
 * the deciding is in them. Who may share, what a recipient may do with a share, and how a Role
 * share resolves against the Roles a reader holds right now are all in `FileService`; the wire
 * shape of a grantee is in `packages/files/src/http.ts` beside the File's own. The routes read
 * params, call one method, and map a `FileError` to a status.
 *
 * Two things reclaimed in the same change. Both Files listings now page through a single
 * `sendPage` helper, so a cursor this instance did not issue means the same thing on both; that
 * cost three lines more than it saved and was still worth doing, because two copies of a paging
 * contract is how the two stop agreeing. And `serializeFilePage` moved to `packages/files`, where
 * the rest of the wire shape already lives — whether a share count is omitted or sent as zero is a
 * fact about what an owner may know, not about Fastify.
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
 *
 * It moves to 51,209 for the `llm` health-probe fix, +37 net in the admin probes this app already
 * owns:
 *
 *   +33 `apps/api/src/admin/health.ts` — the credential verdict is now cached and refreshed out of
 *       band instead of awaited inside `runProbe`'s 2s budget, so a slow-but-working provider can
 *       no longer be raced into `down`, and a deployment with no provider configured reports the
 *       new `unknown` state rather than a failure.
 *   +4  `apps/api/src/admin/model-reachability.ts` — a budget that fits a real cold start.
 *
 * Both are probe wiring for an admin route, which is what `apps/api` is for; the provider
 * behaviour they report on stays in `packages/llm`.
 *
 * It moves to 51,255 for the required-field fix, all of it in `resources/write-pipeline.ts`, which
 * is where a Record write is already validated against its Resource type:
 *
 *   +17 `ajvErrorPath` and its `AjvError` alias. ajv reports `instancePath: ""` for a `required`
 *       failure because the offending property is absent, so the field name lives only in
 *       `params.missingProperty`. Without the translation the 422 carries an empty path and the
 *       form cannot map it onto the input that caused it.
 *   +18 `emptyRequiredField`. JSON Schema `required` asserts presence only, so `""` satisfied a
 *       field the author marked mandatory and the Record persisted blank.
 *   +11 the two call sites in `validateAndLink` that return those 422s.
 *
 * Both are read off the compiled schema at the point the write is already being validated, so
 * neither is a decision this layer owns rather than borrows.
 *
 * It moves to 51,305 for the `Owner` access-level fix, +50 net across the role catalog this app
 * already owns:
 *
 *   +52 `apps/api/src/identity/roles.ts` — `adminOnlyCarveOut()`, which computes `member`'s denies
 *       from the two existing catalogs instead of hard-coding a blanket deny per admin-only
 *       surface, plus `UNRESTRICTED_GRANTS` and the `owner` entry. The blanket deny was the bug:
 *       deny beats allow inside one authority layer, so a member carrying it could never be lifted
 *       by any Role granted on top. Most of the growth is the TSDoc explaining that, because the
 *       narrower deny set looks less safe than the broad one it replaces and is not.
 *   -2  `apps/api/src/pg-migrations/index.ts` — migration v50's seed collapses to the same
 *       unrestricted pair the catalog states, rather than naming resource types no route declares.
 *
 * The catalog is the authority the route gate reads, so it stays here; nothing in it is a decision
 * a package below could own.
 *
 * It moves to 51,473 for `guardrail_forge`, the +168 itemised because a safety surface is the last
 * place a number should be widened without showing the work:
 *
 *   +150 `platform/guardrail-tool.ts`. A Guardrail had a schema, a loader and a live enforcement
 *        pipeline, and no way for an operator to author one — the Guardrails page could only ever
 *        list what a deployment shipped with. This is the missing writer: it merges one guard into
 *        `guardrails.yaml` through `SoulWriter` and re-inits `GuardrailsService`. It stays here for
 *        the same reason `tools/github/` and `tools/slack/` do — a bespoke, non-manifest platform
 *        Tool has no owning package to move to, and it composes `SoulWriter`, the request actor and
 *        the reload hook, all of which are this app's.
 *    +18 `mapSoulWriteError` in `tools/soul-faults.ts`, lifted from `platform/tools.ts` where it
 *        was `routine_forge`'s private copy. Both forge Tools now share one classification of a
 *        rejected changeset, beside `soulCommitFaultCode`, which already owned the question.
 *     -6 net in `platform/tools.ts`: the 13-line private mapper left, and the registration plus
 *        the `onGuardrailsChanged` contract came in.
 *     +5 the `onGuardrailsChanged` composition in `index.ts`. A Turn's Context reads the in-process
 *        `GuardrailsService`, never the published bundle, so the write gateway's own catalog reload
 *        does not reach it. Wiring is the one thing that has to be here.
 *     +1 the `soul.guardrails` row in `identity/roles.ts`, which the role-catalog fitness test
 *        requires for any Tool-enforced resource type.
 *
 * The knowledge that did not stay here: which stage each guard is valid in is
 * `GUARDRAIL_STAGE_BY_GUARD` in `packages/schema/src/guardrails.ts`, beside the stage unions that
 * decide it, so the Tool derives the stage rather than restating the mapping.
 *
 * It moves to 51,508 for the silent-chat-turn fix, +35 net across the two files that own the SSE
 * transport for a Chat Turn:
 *
 *   +25 `apps/api/src/runs/events.ts` — `needs_reconciliation` joins the statuses that close the
 *       stream, and `streamRunEvents` writes a `: keepalive` comment on an idle poll. A Run parked
 *       for reconciliation is not Run-terminal, so the poll loop had no reason to stop and the
 *       response never ended; and because nothing was written until the first Run event existed,
 *       the origin sent zero bytes and the edge answered 524 rather than the backend answering at
 *       all. Most of the growth is the TSDoc separating "stream-terminal" from "Run-terminal",
 *       because the two sets look like they should be one and must not be.
 *   +9  `apps/api/src/chat/sse.ts` — `SSE_KEEPALIVE_MS`, and `writeSseHeaders` now flushing. Node
 *       holds headers until the first body write, so setting them was not answering.
 *   +1  one import in `apps/api/src/chat/routes.ts`.
 *
 * The guarantee this fix exists for did *not* stay here. That a Chat Turn always announces its own
 * failure is enforced in `packages/turn-executor/src/chat-executor.ts`, beside the driver that owns
 * a Turn's lifecycle, so a Turn dispatched by the Worker rather than streamed over HTTP is covered
 * by the same code. Only the transport consequence — when to stop polling, and when to put a byte
 * on the wire — is Fastify-adjacent and therefore here.
 *
 * It moves to 51,638 for Agent capability restrictions, +130 measured against a 51,508 base. The
 * restriction is an authorization boundary rather than stronger prompt wording, so the raise is
 * entirely the wiring that carries an authored Agent to the places a Tool call is decided:
 *
 *   +62 `soul/agents/registry.ts` — `capabilityRestrictions` on the `HostedAgent` the resolver
 *       already builds, plus `delegableToolNames`, which reads the Tool names a restricted Agent
 *       still holds so a delegation can only narrow. Both need the `SoulLoader`, and
 *       `@tulipfarm/soul` may not depend on `@tulipfarm/tool-host`, so this seam is the only place
 *       that can see both. The file's own comment already records why it cannot move. It also now
 *       owns `agentForRunResolver`, which `index.ts` used to hold inline: `scripts/file-size.test.ts`
 *       caps `index.ts` at 1314 lines and forbids widening an allowance to excuse a diff, so the
 *       closure moved to the module that already resolves Agents rather than the number moving.
 *   +28 `chat/turn-helpers.ts` — `toolAgentFor` and the `RestrictedPlatformAgent` type. A raise
 *       that is really a de-duplication: the same intersection had been written inline at three
 *       call sites, and a live Turn and the prompt preview resolving different Tool sets is exactly
 *       how a preview comes to describe a turn that cannot happen.
 *   +17 `internal/turn-host.ts`, +11 `internal/schemas.ts`, +1 `internal/routes.ts` — the Agent now
 *       rides on the Run's authority. `apps/worker` hosts seven mutating Tools with no Soul to
 *       resolve an Agent from, so before this neither the restriction nor the already-landed
 *       autonomy ceiling applied there at all. The schema lines are not optional: Fastify strips an
 *       undeclared response field, so without them the Worker receives no Agent.
 *   +3  `index.ts` — the `agentForRun` and `parentToolNames` composition lines.
 *   +5  `internal/turn-context.ts`, +3 `platform/delegate-tool.ts`, and 0 net in
 *       `chat/conversation-routes.ts` and `soul/agents/tools.ts`.
 *
 * What deliberately did not stay here is why the raise is 115 and not several hundred. The decision
 * itself is `packages/tool-host/src/capability-restrictions.ts`, beside the dispatcher that has to
 * obey it and reachable from both hosts. The authority intersection is
 * `packages/agent-runtime/src/delegation/composition.ts`, which already owned the root authority a
 * chain starts from. The frontmatter shape is `AgentCapabilityRestrictions` in `packages/schema`.
 * And the guidance that makes the field reachable from chat is `skills/forge/agent-forge/SKILL.md`
 * rather than a special case inside the Agent-authoring Tool — the Forge writes frontmatter, so
 * teaching it the key is what closes the gap, and a hand-written branch here would have been the
 * wrong place for it. `apps/api` learned who the Agent is and told the Worker; it did not learn
 * what an Agent may do.
 */

const CEILING = 51_638;

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
