# GitHub App — Registration Manifest

Locked decision for the GitHub App a deployment registers for itself (see
[`GitHub App`](../../metadata/terminologies.md) in the terminology glossary).

**There is no TulipFarm-owned App.** Each deployment creates its own through GitHub's App
Manifest flow, so the App — and its private key and webhook secret — belong to whoever runs that
deployment. Nothing is shared between deployments, and TulipFarm never holds a credential that
could reach a customer's repositories.

This is not a separate artifact from the connect flow: the `app_manifest` step in
[`integrations/github/manifest.yml`](../../integrations/github/manifest.yml) *is* this manifest.
The permissions and events below are the contract that file must match — change them together.

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

Installation-based (not OAuth-user-token, not a shared bot-account PAT). App JWT (RS256, signed
with the App's private key) exchanges for a short-lived (~1hr) installation access token, scoped
only to the repos selected at install time. See
`packages/integrations/src/github/credentials.ts` for the minting implementation.

Both halves are declarative and run on the generic Integration auth broker
(`apps/api/src/integrations/auth-broker.ts`), the same one every other integration uses:

1. **`app_manifest`** — GitHub creates the App from the definition above and returns the App id,
   slug, private key, webhook secret, and OAuth client credentials in exchange for a one-time
   code. Nothing is copied by hand.
2. **`install`** — the operator picks which org and repos the App may touch; the callback carries
   the `installation_id`.

The credentials are sealed under `integration.github.*`, which is exactly where
`INTEGRATION_APPS` (`packages/secrets/src/integration-registry.ts`) resolves each role, so the
token-minting code reads what the flow wrote with no bridging step.
`ensureGitHubInstallation` (`apps/api/src/integrations/github-install.ts`) then records the
`integration_apps` / `integrations` / `integration_access_grants` rows.

## Why App over PAT / OAuth-user-token

- Repo/org-scoped, not user-scoped — doesn't break when an employee leaves.
- Granular, customer-visible permission grant at install time.
- Native per-install webhook delivery, no manual per-repo webhook setup.
- Short-lived tokens vs. a long-lived PAT sitting in a secrets store.
- The App Manifest flow removes the setup step entirely: no operator ever transcribes an App ID,
  a slug, a `.pem`, or a webhook secret.
- Matches the existing `GitHubInstallationScope` code (`packages/integrations/src/github/scope.ts`)
  and the multi-tenant storage model (`integration_apps` → `integrations` →
  `integration_access_grants`) already built for install-based providers.
