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
| 01 | Auth | [`auth.md`](auth.md) | `/login`, `/setup`, `/accept-invite`, `/settings/security` | smoke, full | S1, S2 | fresh incognito context available | 8m |
| 02 | Chat | [`chat.md`](chat.md) | `/`, `/chats`, `/chat/:id` | smoke, full | S1, S2, S7 | LLM provider configured | 12m |
| 03 | Resources | [`resources.md`](resources.md) | `/resources`, `/resources/:type`, `/resources/:type/:id`, `/resources/new` | smoke, full | S1, S3 | — | 12m |
| 04 | Agents | [`agents.md`](agents.md) | `/agents`, `/agents/:name` | full | — | at least one agent, or empty state | 8m |
| 05 | Skills | [`skills.md`](skills.md) | `/skills`, `/skills/:name`, `/skills/marketplace`, `/skills/install` | full | — | marketplace reachable | 12m |
| 06 | Routines | [`routines.md`](routines.md) | `/routines`, `/routines/:slug`, `/routines/:slug/edit`, `/routines/:slug/runs/:runId` | full | — | worker running | 15m |
| 07 | Knowledge | [`knowledge.md`](knowledge.md) | `/knowledge`, `/knowledge/spaces/*`, `/knowledge/pages/*`, `/knowledge/tags/:tag` | smoke, full | S1 | — | 12m |
| 08 | Integrations | [`integrations.md`](integrations.md) | `/integrations`, `/integrations/:name`, `/integrations/marketplace`, `/link-channel` | full | — | integration-worker running; **UI-only, no real OAuth** | 10m |
| 09 | Inbox, approvals, runs | [`inbox-approvals-runs.md`](inbox-approvals-runs.md) | `/inbox`, `/runs`, `/runs/:id`, `/operations` | smoke, full | S1 | worker running | 10m |
| 10 | Settings | [`settings.md`](settings.md) | `/settings/{llm,secrets,security,observability,soul,activities,memory,about}` | smoke, full | S1, S8 | **restore-after required** on any change | 15m |
| 11 | Admin & RBAC | [`admin-rbac.md`](admin-rbac.md) | `/admin/users`, `/admin/roles`, `/admin/guardrails` | full | — | **admin session**; skipped with a note otherwise | 10m |
| 12 | A11y & hygiene | [`a11y-console-hygiene.md`](a11y-console-hygiene.md) | all top-level routes | smoke, full | S1, S2 | preflight baseline captured | 12m |

Playbooks 01 and 03–12 are pending; 00 and 02 exist. See `docs/plans/2026-08-09-qa-agent-playbooks.md`
for build order.

## Ordering

`full` runs in the table order. It is deliberate:

- **Auth before everything** — a broken session invalidates every later result.
- **Resources before agents/skills/routines** — those areas reference resource types, and the
  `qa-*` resource created in 03 is the fixture the later playbooks mention.
- **Routines before inbox/runs** — the routine triggered in 06 is the run inspected in 09.
- **Settings late** — it is the only playbook allowed to mutate configuration, and it restores
  every value it changes.
- **A11y & hygiene last** — it sweeps the console/network deltas accumulated across the whole run.

A single-area invocation runs only preflight plus that playbook, and creates its own fixtures.

## Preconditions that skip rather than fail

| Condition | Behavior |
| --- | --- |
| Non-admin session | Skip `admin-rbac.md` with a `note` |
| No LLM provider configured | Skip `chat.md` S5–S6 with a `note`; S1 becomes a P0 if send fails |
| Worker down | Preflight already aborted — never reached |
| Empty list on a landing page | Not a skip — the empty state **is** the assertion |
