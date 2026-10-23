# Move GitHub sign-in from the OAuth App to one GitHub App per environment

## Context

Today members connect GitHub through an **OAuth App**, which issues classic scoped tokens. Knowledge webhooks need a **GitHub App** (App ID plus webhook secret), and no such App exists yet. The plan is one GitHub App per environment (staging, prod) that does both:

- member sign-in with user-to-server tokens
- Knowledge webhooks

Every current feature must keep working:

- Knowledge indexing: code, issues, PRs, discussions, commits, reader proofs, webhooks
- All member reads and writes

User decisions:

- **Full switch.** No OAuth App fallback. Personal-account Projects v2 stop working (GitHub Apps cannot reach them). Org Projects v2 keep working.
- **Hard cutover.** The new client ID changes `configurationHash`, so every account becomes reconnect-required, and each member reconnects once.

The code is in `TulipFarm/tulipfarm`, based on `origin/main` (48bb429). Do the work in a worktree with one PR per step. After approval, copy this plan to `docs/plans/github-app-migration.md` in the repo.

## What breaks today with App tokens (verified)

```
App user token
 ├─ scope:""      → connect throws (provider.ts:139), prod config throws (configuration.ts:22-28),
 │                  every write scope gate fails, private repos = "Needs permission"
 ├─ 8h expiry     → expires_at = dead → reject() bumps generation → all bindings churn
 │                  (refresh_token dropped at provider.ts:113-120)
 └─ installed     → /user/repos shrinks, GET /repositories/{id} 404 = access-lost
    repos only
```

## 1. GitHub App registration (staging, then prod, under the TulipFarm org)

- **App settings:**
  - Expire user tokens: **ON**
  - Request user authorization during installation: **OFF**
  - Callback: `https://{stg|app}.tulipfarm.ai/github/callback`
  - Setup URL: `/integrations/github`
  - Webhook: `/v1/github/knowledge/events`
- **Repo permissions:**
  - Metadata R
  - Contents RW
  - Issues RW
  - Pull requests RW
  - Discussions RW
  - Actions RW
  - Workflows W
  - Administration RW
  - Checks R
  - Commit statuses R
- **Org permissions:** Projects RW, Members R.
- **Account permissions:** none.
- **Events:**
  - push
  - issues
  - issue_comment
  - pull_request
  - pull_request_review
  - pull_request_review_comment
  - discussion
  - discussion_comment
  - repository
  - installation events (always sent)

## 2. Settings (`packages/config/src/settings.ts:1239-1262`)

- **Reuse** `GITHUB_OAUTH_CLIENT_ID`, `GITHUB_OAUTH_CLIENT_SECRET` and `GITHUB_OAUTH_REDIRECT_URI`, set to the App's values. Then there is no churn in `turbo.json`, `apps/api/turbo.json`, `deploy/pulumi/src/app.ts` or `deploy/docs/secrets.md`.
- **Delete** `GITHUB_OAUTH_SCOPES`.
- **Keep** `GITHUB_WEBHOOK_APP_ID` and `GITHUB_WEBHOOK_SECRET`, pointed at the same App.
- **Add** `GITHUB_APP_SLUG`. It is used only for the install link `https://github.com/apps/<slug>/installations/new`.
- Set the values in Infisical `/app` for stg (`d3d6cdea-…`) and prod (`9d788961-…`).

## 3. Token refresh with no generation bump

Shortcut: `expires_at` keeps its "dead" meaning but now holds the **refresh-token expiry** (6 months). The 8h access expiry goes in a new column. All the dead-on-expiry sites stay unchanged:

- `access/src/github-source.ts`
- `batch-store.ts`
- `selection.ts`
- `knowledge/internal/github.ts`
- the `tf_knowledge_github_readers` view

Changes:

- **Migration** in `packages/workspace-storage/common/` (next number): add `refresh_credential bytea` and `access_expires_at timestamptz` to `tf_github_accounts`.
- **`provider.ts`**
  - `exchange` parses `refresh_token` and `refresh_token_expires_in`.
  - Drop `hasScopes`, `scopes` in the schema, `githubRequiredScopes`, the `scope` URL param, and scopes in `configurationHash`.
  - Add `refresh()`: `grant_type=refresh_token`. A `bad_refresh_token` response throws `GitHubCredentialRejected`.
- **`credentials.ts` / `accounts.ts`**
  - Add the AAD purpose `'refresh'`.
  - `complete` stores both tokens and both expiries, and sets `scopes='{}'`.
- **`withCredential`** (`accounts.ts:345-404`)
  - When `access_expires_at <= now+30m`, run a separate top-level transaction:
    1. Lock the row (`load` is already `FOR UPDATE`).
    2. Re-check the expiry.
    3. Call `refresh()`.
    4. Update both credentials and both expiries. Leave `generation` as is.
  - Then retry the operation once.
  - A 401 when `access_expires_at <= now` refreshes the token instead of calling `reject()`.
  - The row lock serializes refreshes, which matters because GitHub refresh tokens are single-use.
  - First, check that no caller-bound transaction can wrap this.

## 4. Remove scope gates

- **Delete:**
  - `hasScopes`
  - `githubOperationScopes`. The production check keeps only the MCP-bindings rule.
  - `GitHubCredential.scopes`
  - the write gates in:
    - `actions-writes.ts:50`
    - `release-writes.ts:105`
    - `discussion-writes.ts:128`
    - `file-writes.ts:68-69`
    - `repository-writes.ts:104`
    - `project-writes.ts:199,214,227,567`
  - `access/src/protected-source.ts:301`
  - `recommendations.ts:10`
  - `recommendations/context.ts:500-511,793`
  - the scope regex in `device-qualification.ts` and `tooling/github-qualification.mjs`
- **Knowledge**
  - `corpus-provider.ts:835-838` (`scoped()`) and `:1605-1606` become: a private repo is readable when `permissions.pull === true`.
  - Delete the `insufficient-scope` paths at `internal/github.ts:149-170,437,1028-1032`.
- **One 403 mapping** in the write-provider and corpus-provider request helpers: "Resource not accessible by integration" becomes `app-permission-missing`. The message tells the member to ask an org owner to install the App or approve its permissions.
- **Projects:** when the owner type is `User`, return a clear "personal Projects not supported" error.

## 5. Install gaps

- **Discovery** does not change. It now lists only installed repos.
- **A 404** stays `access-lost`.
- **UI:** in `github-knowledge.tsx` and `github-accounts.tsx`, the access-lost and empty-list messages get an "Install the App on more orgs/repos" link.
- **Repo create:** the request succeeds. If the follow-up GET returns 404 (selected-repos install), show the install link.
- **Copy:** update the OAuth App wording at `github-accounts.tsx:52,126-127,136`.
- **Skipped:** a `/user/installations` check to tell "not installed" apart from "lost access". Add it if users get confused.

## 6. Callback and webhooks

- **Callback:** add optional `installation_id` and `setup_action` to `contracts.ts:28-37` and `github-callback.tsx:42-46`, and ignore them.
- **Webhooks:** in `knowledge-github-events.ts`, after the signature check:
  - require `X-GitHub-Hook-Installation-Target-Type: integration`
  - require `X-GitHub-Hook-Installation-Target-ID === GITHUB_WEBHOOK_APP_ID`
  - otherwise return 400
- **Docs:** update `packages/knowledge/GITHUB.md`, covering the OAuth/`repo` rule and the App setup at line 360+.

## 7. PR order

0. **Go/no-go check on MCP.** Create the staging App and get a user token through the local callback. Then call `api.githubcopilot.com/mcp/`:
   - `initialize`
   - `tools/list`
   - `get_me`
   - one private-repo read
   - one issue write

   If any call fails, **stop and decide** before going further. Do not build a REST fallback ahead of time.

1. **Refresh:** migration, provider, accounts, credentials.
2. **Scope-gate removal:** also the 403 mapping and the Projects error.
3. **Callback, webhooks and settings:** also Pulumi, docs, UI copy and the install link.
4. **Prod App and Infisical values,** then deploy (hard cutover).

## Verification

**Tests:** one process at a time, scoped:

- `pnpm --filter @tulipfarm/github test`, then its `test:integration`
- the same for `knowledge`, `access`, `recommendations`, `api` and `web`

New cases:

- refresh near expiry keeps `generation`
- 2 concurrent calls send one refresh POST
- `bad_refresh_token` leads to reconnect-required
- a stale-token 401 refreshes instead of calling `reject()`
- a webhook with the wrong target ID gets 400

**Manual run on staging** (with UI screenshots for the PR):

1. Connect a member. An all-repos source indexes code, issues, PRs, discussions and commits on a private org repo.
2. A push webhook marks the source as changed.
3. A second member's reader proof passes.
4. Force `access_expires_at` into the past in SQL. The next read refreshes the token, and the binding and generation stay the same.
5. Each write works:
   - issue
   - PR
   - merge
   - a file under `.github/workflows`
   - branch
   - release
   - workflow dispatch
   - discussion
   - org Project item
   - repo create, settings and delete
6. A personal Project gives the clear error.
7. Remove the App from a repo. The member sees access-lost plus the install link.
