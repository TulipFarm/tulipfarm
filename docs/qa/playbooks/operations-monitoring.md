---
id: operations-monitoring
area: Operations & Dispatch
suites: [smoke, full]
routes: ["/operations"]
preconditions: [signed-in session, worker running on :4020]
blast_radius: none — read-only system monitoring dashboard
est_minutes: 8
smoke_scenarios: [S1]
---

# Operations & Worker Dispatch Monitoring

The System Operations dashboard (`/operations`) provides real-time visibility into the TulipFarm background worker process (`:4020`), durable run dispatch queues, active agent locks, projection engine lag, memory synchronization status, and integration ingress channels.

Every scenario stands alone — a failure in one does not block the next.

## S1 — Operations dashboard overview and worker health

| # | Action | Expected |
| --- | --- | --- |
| 1 | `navigate /operations` | Operations dashboard loads within 5s; heading `Operations` or `System Operations` |
| 2 | `expect` worker status card displays `Worker Status: Healthy / Running` (checking `:4020` backend) | Worker status visible |
| 3 | `expect` key metric cards render: `Active Runs`, `Queued Dispatch Jobs`, `Projection Lag`, `Lock Count` | Metric cards rendered |
| 4 | `capture` screenshot, console delta, failed requests | — |

## S2 — Queue inspection and active locks table

| # | Action | Expected |
| --- | --- | --- |
| 1 | Inspect **Dispatch Queue** table | Shows job ID, run ID, target routine/agent, state (queued/running/completed/failed), and enqueue time |
| 2 | If queue is empty, `expect` empty state message "No active or queued dispatch jobs." | Empty state rendered |
| 3 | Inspect **Active Locks** section | Displays resource/agent lock keys, owner run ID, and lease expiration timer |
| 4 | `click` `Refresh Status` action button | Dashboard metrics and queue tables refresh without full page reload |
| 5 | `capture` screenshot, console delta, failed requests | — |

## S3 — Projection engine lag & memory sync status

| # | Action | Expected |
| --- | --- | --- |
| 1 | Locate **Projections & Sync** panel | Lists projection names (e.g. `audit_projections`, `run_state_projections`), current offset, and lag metric |
| 2 | `expect` lag metrics display numerical values or "0 ms" | Valid numeric metrics |
| 3 | Inspect **Integration Ingress Status** section | Displays active listener channels and event processing rate |
| 4 | `capture` screenshot, console delta, failed requests | — |

## S4 — Worker down resilience check

| # | Action | Expected |
| --- | --- | --- |
| 1 | If worker service is simulated down or unreachable, `expect` dashboard displays a clear Warning alert banner: "Worker process on port 4020 is unreachable" | Graceful degradation alert |
| 2 | `expect` page does not crash, render unhandled React exception, or freeze browser tab | Page remains responsive |
| 3 | `capture` screenshot, console delta, failed requests | — |

## S5 — Accessibility, themes, and mobile viewports

| # | Action | Expected |
| --- | --- | --- |
| 1 | Tab through metric cards, refresh controls, and table rows | Keyboard focus rings visible |
| 2 | Toggle between Light and Dark themes | Status indicators (green healthy, yellow lag, red error) remain high-contrast and legible |
| 3 | Resize viewport to 375px mobile width | Metric grid stacks vertically; tables scroll horizontally inside containers without page body overflow |
| 4 | `capture` screenshot, console delta, failed requests | — |

## Notes for the runner

- Read-only dashboard: inspect metrics and status indicators without attempting manual queue purges or DB mutations.
- Confirm worker process on `:4020` is running during preflight.
