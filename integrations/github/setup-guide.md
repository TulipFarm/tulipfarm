# Connect GitHub

1. Go to `github.com/settings/apps/new` (or `github.com/organizations/<org>/settings/apps/new`
   for an org) → fill in:
   - **GitHub App name**: anything identifying, e.g. "TulipFarm — Acme Inc".
   - **Homepage URL**: your deployment's public URL (`PUBLIC_URL`).
   - **Callback URL**: leave blank, and leave "Request user authorization (OAuth) during
     installation" unchecked — TulipFarm authenticates as the App installation, never as a
     GitHub user.
   - **Setup URL** (under *Post installation*): `<PUBLIC_URL>/api/v1/integrations/github/install/callback`,
     and check **Redirect on update**.
     - **Local dev**: the API has its own port (`:4010`), separate from the web app (`:4000`) —
       there's no dev proxy between them, so this must target the API port, e.g.
       `http://localhost:4010/api/v1/integrations/github/install/callback`. Leaving it empty (or
       pointing at `:4000`) means GitHub never calls back: the install still looks fine on
       GitHub's own page, but nothing gets written on this side and the integration stays
       "disconnected" here.
     - **Production**: web and API share one origin, so `PUBLIC_URL` is correct for both the
       Homepage URL and the Setup URL.
   - **Webhook → Active**: leave unchecked — TulipFarm doesn't process GitHub webhook events yet.
   - **Permissions**: Contents (Read and write), Issues (Read and write), Pull requests (Read and
     write), Checks (Read-only). Metadata (Read-only) is added automatically.
   - **Where can this GitHub App be installed?**: "Only on this account" unless you specifically
     want it installable across other orgs.

   Click **Create GitHub App**.

2. **Collect credentials** from the App's page: the **App ID** (top of the page), the **App
   slug** (last segment of `github.com/settings/apps/<slug>`), and a **private key** — scroll to
   Private keys → Generate a private key, which downloads a `.pem` file (can't be re-downloaded,
   only regenerated).

3. **Store them**: Settings → Secrets → add each as a custom secret:

   | Key | Value |
   | --- | --- |
   | `github-app-id` | the App ID |
   | `github-app-slug` | the App slug |
   | `github-app-private-key` | full contents of the downloaded `.pem` file, `BEGIN`/`END` lines included |
   | `github-app-webhook-secret` | any value — reserved for webhook verification, not read yet |

4. **Install**: click **Install** on this page. You're sent to GitHub to pick an organization or
   account, then choose **all repositories** or **selected repositories** — you can change this
   later from GitHub's own installation settings.
5. Approve the install. GitHub sends you back here and the connection shows the account and repos
   TulipFarm can now see.
6. To add or remove repos, or to uninstall, use GitHub's installation settings
   (`github.com/settings/installations`) — TulipFarm's repo access always matches what's granted
   there, nothing to sync on this side.

No tokens to copy or paste for day-to-day use: the installation itself is the credential, and
TulipFarm mints short-lived access tokens from it as needed.
