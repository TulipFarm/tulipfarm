# Authorization design

Status: **Partially implemented — steps 1, 2, 3 and most of 4 of §5 have landed; steps 5 and 6 have not.**

The decision engine, the persisted principal model, both adapters D4 asks for, and the shadow-mode
rehearsal path are built and in the request path. What remains is product scope: Soul-authored
policy and per-Record predicates. §2 below is the evidence that motivated this document and is
retained as written; read [§2.1](#21-what-has-changed-since) first for what has since changed.

Scope: the authorization model for human users, Agents, Routines, and service identities across
Soul artifacts, Secrets, business settings, Integrations, and Resource Records.

This document exists because the [decision index](decision-index.md) change-control clause requires
a reviewed ADR before any change that "adds an authority/write/effect path". It extends ADR-009
(effective authority is an intersection), ADR-010 (Skills never grant Tools), and ADR-011 (one
broker). It does not weaken them.

---

## 1. Framing principle

**TulipFarm ships the authorization mechanism. The business authors the authorization content.**

We ship: login, OAuth, principals, groups, relations, grants, the decision engine, the enforcement
chokepoint, and persistence.

The business authors: its own domains, departments, hierarchy, roles, and approval routing.

This is load-bearing, not a preference. A factory, an engineering company, and a professional
services firm have genuinely different org shapes — one manager versus three levels of them — and
different routing for the same request type ("all leave goes to my manager" versus "comp leave goes
elsewhere"). TulipFarm must express all of them without knowing any of them. Any hardcoded
department list, role taxonomy, or approval chain is a defect.

The person authoring this is the business's own system/information architect, not a TulipFarm
engineer.

---

## 2. Why change — evidence

Measured against the working tree, not documentation. **These measurements are historical — they are
the case for writing this document, not a description of the repo today.** See §2.1.

**The decision engine is effectively unreachable.** `decideEffectivePermission` — which
`packages/authz/AGENTS.md` calls the sole accountable owner of authority-intersection decisions —
has exactly one call site in the repository: `packages/tool-broker/src/authorize.ts:78`. In
production it is reached only by the Routine path, where the sole authority layer is derived from
the Run's pinned ToolContracts. `apps/worker/src/main.ts:326` states it directly:

> "No `authority` callback is passed: the bundle-derived layer above is this Run's only authority."

**Consequence: no human identity has ever entered an authority-intersection decision.** The Chat
path — `apps/api/src/platform/tools.ts`, ~30 Tools including Routine Forge and Skill Forge — never
calls it at all.

**There can be exactly one administrator per deployment.**

```sql
CREATE UNIQUE INDEX users_single_admin_idx ON users (role) WHERE role = 'admin'
```

A partial unique index. Authority is a single scalar `users.role` column, enforced by 16
`requireAdmin` and 8 `role === "admin"` checks spread across route files.

**The `member` role is fail-open by construction.** `apps/api/src/identity/roles.ts` grants
`ANY_ACTION_ANY_RESOURCE` and then subtracts eight explicit denies. Since `grantMatches` treats an
omitted dimension as covering every value of it, that blanket allow matches every request. Every new
resource type is permitted to every member until somebody remembers to write a deny.

**Policy description and policy enforcement are two artifacts kept in sync by hand.**
`identity/roles.ts` is candid about it:

> "TulipFarm gates authority on `user.role` today — there is no role editor and no roles table, so
> this catalog is a faithful description of the checks in the codebase, not an aspirational model."

Its own comments record a bug where the description drifted and told members they could not touch
their own API tokens.

**Three disconnected models coexist.** `packages/authz` (1,554 LOC of well-tested algebra, no
persistence — there is no `principals`, `roles`, or `access_grants` table among 54 tables);
`users.role`; and `integration_access_grants` (`packages/storage/src/integrations/integration-store.ts:74`),
a separate `definition jsonb` grant model.

**Approvals route by role only.** `packages/authz/src/approval/decision.ts:57` —
`allowedApproverRoles: readonly string[]`. A set, not a relation. This cannot express "my manager".

**"Direct Soul file/Git mutation" is already a rejected alternative** in the decision index, yet the
Forge Tools do exactly that (`fs.writeFile` + `git add -A`, no mutex) while reaching zero
authorization checks. The Tools with the most authority have the least governance.

**What is not wrong:** the grant algebra itself. Default-deny, deny-wins, intersection-only
narrowing, fail-closed dimension scoping, cycle-safe role composition, separation-of-duties on
approvals. It does not need replacing. It needs persistence, a chokepoint, names, and relations.

### 2.1 What has changed since

Re-measured against the working tree on 15 Aug 2026. Every row below was verified in code, not in
documentation. The direction of drift is uniformly *good*, which means the §2 evidence above now
overstates the problem.

| §2 claim | Today |
| --- | --- |
| `decideEffectivePermission` has **one** call site | **Four.** `packages/tool-broker/src/authorize.ts:79`, `apps/api/src/authz/route-gate.ts:60`, `apps/api/src/authz/service.ts:403`, `apps/api/src/resources/authorize.ts:68` |
| No human identity has ever entered an intersection decision | **False now.** Every gated route builds an `L1` principal layer from live assignments |
| 16 `requireAdmin` + 8 `role === "admin"` checks | **0 `requireAdmin`; 2 role comparisons**, both non-decisions — the gate's own implementation, and a last-admin target-row invariant |
| `member` is fail-open via `ANY_ACTION_ANY_RESOURCE` | **Removed.** The identifier does not appear anywhere in the repo; `member` is an allow-list (`MEMBER_ALLOWED_SURFACES`). **D3 is done for the shipped roles** |
| No `principals`, `roles`, or grant tables among 54 | **Eight exist** — `principals`, `roles`, `role_parent_roles`, `role_grants`, `principal_groups`, `principal_group_members`, `role_assignments`, `group_role_assignments` (`packages/storage/src/auth/role-repo.ts`), kept in step with `users` by the `users_sync_authorization` trigger |
| Exactly one administrator per deployment | **Lifted.** `users_single_admin_idx` is dropped in `seedAuthorizationBootstrap`; the `owner` role and `owners` group are seeded. **D7 has landed** |
| Forge Tools write Soul with `fs.writeFile` + `git add -A`, no mutex, zero authorization | **Closed.** All artifact writes go through `SoulWriter`; commits stage only the paths they name; the ~30 platform Tools carry authorization declarations |

What was genuinely missing, and is now built, was narrower than §2 implies: **the HTTP half of D4**.
The engine, the algebra, the tables and the Tool adapter all existed. Routes were the one caller
still deciding for themselves — 36 inline comparisons across 16 files, now 46 declared routes across
22 files reaching the engine through `apps/api/src/authz/route-gate.ts`.

One security defect was found by that migration and is worth recording, because it is the argument
for step 1 in a single example: `PUT /api/v1/soul/git-config` re-points the Soul repository — the
store holding every artifact in the deployment — and was gated by authentication alone. Any member
could have pointed it at a remote they controlled. Requiring each route to state its authorization
out loud is what surfaced it.

---

## 3. Decisions

| ID | Decision |
| --- | --- |
| **D1** | Role *definitions* live in Soul (versioned, reviewed, published). *Assignments* live in Postgres (immediate, revocable). Authorization is always evaluated against live data, **never** a Run-pinned copy. |
| **D2** | `domain` becomes a first-class dimension on `AccessGrant` and `AccessRequest`. Domain **values** are business-authored; TulipFarm defines none. |
| **D3** | Roles are **allow-list**. `ANY_ACTION_ANY_RESOURCE` is removed from every role. A new resource type is unreachable until some role grants it. |
| **D4** | One decision function, two thin adapters: an HTTP route preHandler and the broker's `authorizeToolIntent`. Both build `AuthorityLayer`s from the same source. No other code may decide. A CI rule fails any route or Tool with no authorization declaration. |
| **D5** | Per-Record access is **attribute-based**, compiled into a SQL `WHERE` predicate. Explicit per-Record grants exist only as a narrow sharing exception. |
| **D6** | Relation resolution is **bounded** and stays in our own engine: the business declares relation types plus rules from a fixed operator set (traverse *n* hops, filter by group, filter by domain, fallback). Tuples in Postgres, resolved by recursive CTE. No expression language, no second service. |
| **D7** | Day-one authority is a self-retiring `owner` bootstrap role holding `authz.*`. It is an ordinary role evaluated by the same gate and audited; the deployment warns while more than one principal holds it. `users_single_admin_idx` is dropped. |
| **D8** | Authorization governs itself. `authz.role`, `authz.assignment`, and `authz.relation` are protected resources under the same gate. |
| **D9** | Agent authority is the **intersection** of its own role and the delegating principal's — never a union. Already the designed intent; not re-litigated. |

### Rationale for the non-obvious ones

**D1** — Revocation must be immediate, so assignments cannot be pinned or published. Policy benefits
from review and history, so definitions should be. The clean statement of the split: **Soul holds
the shape of the org; Postgres holds its current contents.**

**D2** — Orthogonal separation, not hierarchical. HR is not above or below Engineering, so no role
hierarchy can express it. A dedicated dimension fails closed when a request omits it, whereas
burying `domain` in the generic `conditions` bag makes it invisible and easy to forget to populate.

**D3** — Without this, D2 accomplishes nothing: a grant omitting `domain` covers every domain, so
the blanket allow would still reach HR data. This is the single most consequential change in the
document.

**D6** — Scale does not justify Zanzibar. One business per deployment (ADR-001) means thousands of
principals, not billions; a `relation_tuples` table with a recursive CTE is sufficient, and a
self-hosted deployment should not need to run OpenFGA. More importantly, **neither Cedar nor OpenFGA
models the five-layer intersection with per-layer denial evidence** — adopting either would mean
evaluating it once per layer (losing their analysis tooling) or flattening the layers (losing the
agent-governance property that is the entire point of ADR-009).

**D7** — The root of authority must be explicit and travel the same path as everything else. Today
it is implied by a database index, which is neither auditable nor expressible in policy.

**D8** — Without it, "can write Soul" silently becomes "can grant myself anything" the moment roles
live in Soul. Given the Forge Tools currently write Soul with no authorization at all, this hole is
live today.

---

## 4. Target shape

### Soul — the shape of the org

```
soul/authorization/
  domains.yaml          # the business's own taxonomy — hr, engineering, plant-floor, …
  roles/<id>.yaml       # allow-list grants: action × resource × domain
  relations.yaml        # relation types the business uses: reports_to, owns, delegates_to
  routing/<id>.yaml     # approver = reports_to(requester, hops: 1..3), filtered by domain
```

Authored through the Soul changeset and publication gateway (ADR-007) like every other artifact —
schema-validated, policy-checked, audited, published.

### Postgres — the current contents

```
principals                  # modelled in packages/authz today, never persisted
principal_groups            # business-defined sets
principal_group_members
role_assignments            # principal → role, optional domain scope, optional expiry
relation_tuples             # (subject, relation, object) — the org graph
```

### The decision path

```
request
  → gate  (route preHandler | broker authorizeToolIntent)
  → build AuthorityLayers:
        L1  user / principal    LIVE    assignments × published role definitions
        L2  agent               LIVE    the Agent's own role
        L3  run context         PINNED  bundle ToolContracts (exists today)
        L4  guardrail           PINNED  guardrail policy (exists today)
        L5  credential scope    LIVE    integration grant
  → decideEffectivePermission   intersection · deny-wins · default-deny
  → for Record queries: compile attribute predicate → SQL WHERE
```

**Invariant.** L1, L2, and L5 are always live; L3 and L4 stay pinned. Because intersection only
narrows (ADR-009), live layers compose safely with pinned ones — revoking L1 lands mid-flight on a
Routine that pinned L3 hours earlier. Authority is never pinned to a bundle digest.

### Resource name grammar

Two levels, exact match — no prefix matching, so `grantMatches` needs no change.

| Namespace | Membership | Examples |
| --- | --- | --- |
| `platform.*` | closed | `platform.secret`, `platform.setting`, `platform.user`, `platform.integration`, `platform.model` |
| `soul.*` | closed | `soul.agent`, `soul.skill`, `soul.routine`, `soul.resource_type` |
| `record.<resource_type_id>` | **open** — business-defined | `record.leave_request` |
| `authz.*` | closed | `authz.role`, `authz.assignment`, `authz.relation` |

The open `record.*` namespace is why the grammar must be a convention rather than an enum: Resource
types are authored at runtime.

The closed namespaces are enumerated in `packages/authz/src/resources.ts`, and
`scripts/authz-resource-grammar.test.ts` fails the build when that table and this one disagree.

**`platform.model`** covers which model a principal may cause a call to. A chat request names a
model as a free string — an effort preset, a ModelProfile ref, or a raw provider model id — and it
reached the provider having passed only a capability-fit check. Without a resource there was
nothing to default-deny against, so invariant 3 had nothing to apply to on the layer that spends
the money. The named model travels as the request's `recordId`, so a grant can be written for one
model, for a set of them, or for all of them.

### Package placement

`packages/authz` may import only `@tulipfarm/schema` and `@tulipfarm/observability`, so it cannot
reach a database. It therefore owns the **pure algebra and the relation-resolution port**; the
recursive CTE implementation lives in `packages/storage`. This follows from the existing rank
ordering rather than being a new decision.

---

## 5. Implementation sequence

Ordering principle: **declare before enforce.** The allow-list flip (D3) is the one step that can
lock users out of their own deployment, so it must be preceded by evidence.

| # | Piece | Behaviour change | Acceptance | Status |
| --- | --- | --- | --- | --- |
| 1 | Name grammar + an authorization declaration on every route and Tool | none — inert metadata | `N of M` declared, ratcheting to 100% in CI | **done** — Tools 74/74, routes 46 across 22 files; ratchet is `scripts/route-authorization.test.ts` with an empty debt list |
| 2 | The gate in **shadow mode** — evaluates and logs what it *would* deny, using today's admin/member | none | zero unexpected would-denies over real traffic | **done** — `AUTHZ_MODE=shadow` serves the declaration's `fallback` while still running the engine; every disagreement is logged as `authz.divergence`. Threaded through `buildApp`, so it covers every gated route, not only the two direct call sites |
| 3 | Flip the gate to enforcing; retire `requireAdmin` | **yes — the first real one** | shadow-mode evidence from step 2 | **done** — `requireAdmin` is gone and gated routes enforce today. Reached before step 2 rather than after it; the ordering debt that created is discharged by shadow mode now existing. See the note below |
| 4 | Persist principals, groups, assignments, relation tuples; retire `users.role` and `users_single_admin_idx` | multiple administrators become possible | existing users keep exactly their current reach | **done, less two pieces that this table mis-ordered** — eight tables persisted, `users_single_admin_idx` dropped, `users_sync_authorization` keeps them in step. `users.role` and `relation_tuples` are blocked on step 5, not on this step; see the note below |
| 5 | Soul-authored domains, roles, relations, routing | the business can model itself | a leave-approval routing rule resolves end to end | **partial** — Roles *are* Soul-authored: `soul/roles/` loads into `SoulRole`, `reconcileSoulRoles` projects them into durable rows, and `authz/routes.ts` exposes 17 authoring routes behind the access UI. Domains, relations and routing remain, and `DEPLOYMENT_ROLES` in `identity/roles.ts` is still the compiled-in baseline the deployment boots with |
| 6 | Attribute predicates compiled into SQL | per-Record access | list, count, and RAG results stay mutually consistent | **not started** |

Steps 1–3 close the Forge governance hole as a side effect: declaring what those ~30 platform Tools
require *is* what puts them behind a gate for the first time.

**On the step-2/3 inversion.** Enforcement arrived without shadow-mode evidence, which is not the
order this section prescribes. What made that safe in practice — not by design — is that the route
adapter's `fallback` field is **required**, so a declaration can only ever restate or narrow the
check it replaced, never widen it, and the migration was one surface at a time behind a full test
suite. That reasoning does **not** extend to the D3 flip for business-authored roles, where a wrong
allow-list genuinely can lock a deployment out of itself.

Shadow mode now exists, so that debt is discharged rather than merely acknowledged:

- `AUTHZ_MODE=shadow` makes the gate serve each declaration's `fallback` while still evaluating
  `decideEffectivePermission`, so an operator can rehearse a policy change against real traffic
  before it can refuse anyone.
- Divergences are recorded in **both** modes, not only in shadow. Under `enforcing`, a logged
  `fallbackAllowed: false, engineAllowed: true` is a grant that is *wider* than the static check it
  replaced — precisely what ADR-009 forbids — and there was previously no way to see one.
- The default is `enforcing`. A deployment has to opt out; it can never fall into shadow mode by
  leaving a variable unset.
- An engine that *throws* is contained: under `shadow` the failure is recorded as
  `engineAllowed: "threw"` and the request is served from its `fallback`, because a rehearsal that
  can take the deployment down is not a rehearsal. Under `enforcing` it propagates, since there an
  unanswerable check has to be a refusal.

Before step 5 lands, run a deployment in shadow mode long enough to see zero unexpected
`authz.divergence` would-denies, which is the acceptance criterion step 2 always asked for.

**On the two pieces step 4 still lists.** Both were placed in step 4 by this table and neither
belongs there:

- **`users.role`** is the policy source for `isDeploymentAdmin`, which backs every declaration's
  required `fallback`. That field is what guarantees a route with no authorizer wired still refuses
  somebody — the safety property the whole gate rests on. `users.role` therefore cannot be retired
  until `fallback` can be, and `fallback` cannot be until Soul-authored Roles are guaranteed present
  in every deployment. It is ordered **after** step 5, not before it.
- **`relation_tuples`** has no reader. Nothing in the decision path resolves a relation yet, because
  relations are step 5's work and per-Record predicates are step 6's. Creating the table now would
  ship a schema, a repository and a test suite that no production entrypoint reaches — the precise
  defect class `pnpm reachability:check` exists to catch. Build it when step 5 gives it a caller.

Recording this is the point: an "outstanding" item that is actually blocked reads as neglect, and
the next person re-derives the ordering from scratch.

---

## 6. Open questions

- **Authoring surface.** How the business architect writes domains, roles, and routing — agentic
  Chat, a dedicated UI, or both. Real product scope; undecided.
- **What `member` becomes.** ~~Flipping to allow-list locks out every existing user unless a default
  role reproduces today's reach.~~ **Answered for the shipped roles:** `member` is already an
  allow-list (`MEMBER_ALLOWED_SURFACES`) and `ANY_ACTION_ANY_RESOURCE` is gone. The question survives
  for *business-authored* roles at step 5, where the same lockout risk returns without shadow-mode
  evidence.
- **Retiring `users.role`.** Becomes a seeded assignment, then the column is dropped.
- **`integration_access_grants`.** Whether it folds into the unified model or stays a distinct
  credential-scope layer (L5).

---

## 7. Invariants this design must preserve

1. Authority only ever narrows across layers (ADR-009). No path may union.
2. Authorization is evaluated live. No decision is served from a Run-pinned copy.
3. Default deny. An absent grant, an absent layer, and an unpopulated dimension all deny.
4. One decision function. A second implementation of the intersection is a defect.
5. Authorization changes are themselves authorized (D8) and audited.
6. TulipFarm ships no domain, department, role, or approval-chain content.
