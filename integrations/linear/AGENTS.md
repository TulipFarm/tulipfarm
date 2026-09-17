# Linear integration

Fixed, digest-pinned GraphQL operations for Linear issues and team metadata.

## Read on / Skip

- Read for Linear capabilities, fixtures or setup. Skip for generic transport/auth changes.

## Map

| Path | Owns |
| --- | --- |
| `oim.yml`, `operations/` | OIM contracts and fixed GraphQL documents |
| `manifest.yml` | Legacy declarative compatibility surface |
| `fixtures.yml` | Offline provider-shaped responses and expected requests |
| `setup-guide-oim.md`, `setup-guide.md` | Setup and unresolved production capability boundaries |

## Rules

- Never mark available without production `requireVerification: true` activation and real
  GraphQL provider verification. HTTP GET-only verification is not compatible with `Viewer`.
- Keep matching legacy/OIM variables and selections consistent; update companion SHA-256 pins.
- Every connection read is paged; never describe one page as a complete list.
- Status and assignee ids come from the issue's own Linear team metadata.
- Team members are not a Knowledge ACL; GraphQL page cursors are not polling watermarks.

See [capability boundaries](setup-guide-oim.md#activation-and-background-capability-boundaries).
