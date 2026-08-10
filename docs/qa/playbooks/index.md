# Playbook index

Suite membership, preconditions, and duration for every QA playbook. The runner reads this to
decide what a given invocation executes.

## Suites

| Suite | Contents | Duration |
| --- | --- | --- |
| `smoke` | Preflight + the `smoke_scenarios` of every smoke playbook | ~10–15 min |
| `<area>` | Preflight + that one playbook in full | 5–15 min |
| `full` | Preflight + every playbook in full, serially | ~60–90 min |

Preflight always runs. It is the only playbook that aborts the run on failure.

## Playbooks

| # | Area | File | Routes | Suites | Smoke scenarios | Preconditions | Est. |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 00 | Preflight | [`00-preflight.md`](00-preflight.md) | all | always | all | dev servers up, signed in | 3m |
| 01 | Auth | [`auth.md`](auth.md) | `/login`, `/setup`, `/accept-invite`, `/settings/auth`, `/business/people` | smoke, full | S1, S2 | fresh incognito context available | 8m |
| 02 | Chat | [`chat.md`](chat.md) | `/`, `/chats`, `/chat/:id` | smoke, full | S1, S2, S7 | model provider configured | 12m |
| 03 | Resources | [`resources.md`](resources.md) | `/resources`, `/resources/:type`, `/resources/:type/:id`, `/resources/new` | smoke, full | S1, S3 | — | 12m |
| 04 | Agents | [`agents.md`](agents.md) | `/agents`, `/agents/:name` | full | — | at least one agent, or empty state | 8m |
| 05 | Skills | [`skills.md`](skills.md) | `/skills`, `/skills/:name`, `/skills/marketplace`, `/skills/install` | full | — | marketplace reachable | 12m |
| 06 | Routines | [`routines.md`](routines.md) | `/routines`, `/routines/:slug`, `/routines/:slug/edit`, `/routines/:slug/runs/:runId` | full | — | worker running | 15m |
| 07 | Knowledge | [`knowledge.md`](knowledge.md) | `/knowledge`, `/knowledge/spaces/*`, `/knowledge/pages/*`, `/knowledge/tags/:tag` | smoke, full | S1 | — | 12m |
| 08 | Integrations | [`integrations.md`](integrations.md) | `/integrations`, `/integrations/:name`, `/integrations/marketplace`, `/link-channel` | full | — | integration-worker running; **UI-only, no real OAuth** | 10m |
| 09 | Inbox, approvals, runs | [`inbox-approvals-runs.md`](inbox-approvals-runs.md) | `/inbox`, `/runs`, `/runs/:id`, `/operations` | smoke, full | S1 | worker running | 10m |
| 10 | Settings | [`settings.md`](settings.md) | personal `/settings/{profile,appearance,auth,memory}` + business `/business/*` config | smoke, full | S1, S8 | **restore-after required** on any change | 15m |
| 11 | Admin & RBAC | [`admin-rbac.md`](admin-rbac.md) | `/business/people`, `/business/guardrails` | full | — | signed-in session; admin for People | 10m |
| 12 | A11y & hygiene | [`a11y-console-hygiene.md`](a11y-console-hygiene.md) | all top-level routes | smoke, full | S1, S2 | preflight baseline captured | 12m |
| 13 | Surface Protocol | [`dev-surfaces.md`](dev-surfaces.md) | `/dev/surfaces` | smoke, full | S1 | — | 10m |
| 14 | Channel Linking | [`channel-linking.md`](channel-linking.md) | `/link-channel` | smoke, full | S1 | integration-worker running | 8m |
| 15 | Operations & Dispatch | [`operations-monitoring.md`](operations-monitoring.md) | `/operations` | smoke, full | S1 | worker running | 8m |
| 16 | Audit & Compliance | [`audit-compliance.md`](audit-compliance.md) | `/business/activities` | smoke, full | S1 | — | 10m |
| 17 | Design System | [`design-system.md`](design-system.md) | `/design-guide` | smoke, full | S1 | — | 8m |
| 18 | Setup & Onboarding | [`onboarding-setup.md`](onboarding-setup.md) | `/setup`, `/onboarding` | smoke, full | S1 | fresh incognito context available | 8m |
| 19 | Guardrails & Governance | [`guardrails-governance.md`](guardrails-governance.md) | `/business/guardrails` | smoke, full | S1 | signed-in session; admin for writes | 10m |
| 20 | Memory Lifecycle | [`memory-lifecycle.md`](memory-lifecycle.md) | `/settings/memory` | smoke, full | S1 | — | 10m |
| 21 | Soul Git Operations | [`soul-git-operations.md`](soul-git-operations.md) | `/business/soul` | smoke, full | S1 | — | 10m |
| 22 | Models Fallback Resilience | [`llm-fallback-resilience.md`](llm-fallback-resilience.md) | `/business/models` | smoke, full | S1 | model provider configured | 10m |

All 23 playbooks (00 through 22) are fully implemented and ready for execution across every route, state machine, and subsystem. See `docs/plans/2026-08-09-qa-agent-playbooks.md` for background and architecture decisions.

## Ordering

`full` runs in the table order. It is deliberate:

- **Auth before everything** — a broken session invalidates every later result.
- **Resources before agents/skills/routines** — those areas reference resource types, and the
  `qa-*` resource created in 03 is the fixture the later playbooks mention.
- **Routines before inbox/runs** — the routine triggered in 06 is the run inspected in 09.
- **Settings late** — it is the only playbook allowed to mutate personal and business configuration, and it restores
  every value it changes.
- **A11y & hygiene last** — it sweeps the console/network deltas accumulated across the whole run.

A single-area invocation runs only preflight plus that playbook, and creates its own fixtures.

## Preconditions that skip rather than fail

| Condition | Behavior |
| --- | --- |
| Non-admin session | Skip People scenarios in `admin-rbac.md` with a `note`; Guardrails read checks still run |
| No model provider configured | Skip `chat.md` S5–S6 with a `note`; S1 becomes a P0 if send fails |
| Worker down | Preflight already aborted — never reached |
| Empty list on a landing page | Not a skip — the empty state **is** the assertion |
