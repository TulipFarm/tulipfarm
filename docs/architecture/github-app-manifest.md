# GitHub App — Registration Manifest

Locked decision for the single, TulipFarm-owned GitHub App (see [`GitHub App`](../../metadata/terminologies.md)
in the terminology glossary). This is the manifest registered once on GitHub, not the
per-customer connect flow (that's `integrations/github/manifest.yml`, a separate artifact —
see Phase 8 of the GitHub integration build).

## Permissions requested (base install)

| Permission | Level | Why |
|---|---|---|
| `contents` | `write` | Read repo files, commit + push branches (agent-authored code changes) |
| `issues` | `write` | Read/search/comment/label/assign/close issues |
| `pull_requests` | `write` | Create/read/comment/review/merge PRs |
| `checks` | `read` | Read CI/check-run status for PR gating |
| `metadata` | `read` | Mandatory baseline permission for any GitHub App |

**Not requested by default**: `administration` (org/repo admin — repo creation, branch
protection). Only requested as an incremental re-auth scope when a customer opts into
"create the soul repo for me" during onboarding (Phase 10) or when repo-management
contracts (branch protection, secrets, releases) ship in a later phase — deferred, per
the locked contract-scope decision.

## Webhook events subscribed

- `issues`
- `issue_comment`
- `pull_request`
- `pull_request_review`
- `push`
- `check_run`
- `check_suite`
- `installation`
- `installation_repositories`

## Auth model

Installation-based (not OAuth-user-token, not a shared bot-account PAT). One App
definition; each customer installs it into their own GitHub org/repos, picking which
repos are in scope at install time. App JWT (RS256, signed with the App's private key)
exchanges for a short-lived (~1hr) installation access token, scoped only to that
customer's selected repos. See Phase 1 (`packages/integrations/src/github/credentials.ts`)
for the minting implementation.

## Why App over PAT / OAuth-user-token

- Repo/org-scoped, not user-scoped — doesn't break when an employee leaves.
- Granular, customer-visible permission grant at install time.
- Native per-install webhook delivery, no manual per-repo webhook setup.
- Short-lived tokens vs. a long-lived PAT sitting in a secrets store.
- Matches the existing `GitHubInstallationScope` code (`packages/integrations/src/github/scope.ts`)
  and the multi-tenant storage model (`integration_apps` → `integrations` →
  `integration_access_grants`) already built for install-based providers.
