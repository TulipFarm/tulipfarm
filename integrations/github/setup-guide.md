# Connect GitHub

The native GitHub channel receives events and delivers agent replies in the repositories you
select. A separate OAuth App supports personal GitHub authorization. Third-party Agent Tools
use an MCP server rather than this channel's GitHub App.

## 1. Create the App

Click **Create the GitHub App**. You'll land on GitHub with the App's name, permissions, webhook
URL, and callback already filled in from
[`manifest.yml`](manifest.yml). Review it, pick the account or organization that should own the
App, and confirm.

GitHub sends you straight back, and TulipFarm stores the App ID, slug, private key, webhook
secret, and App client credentials automatically.

> The App belongs to **you**, not to TulipFarm. There is no shared vendor-owned App: the private
> key is generated for your deployment and never leaves it.

## 2. Configure personal GitHub access

Open [GitHub Developer settings](https://github.com/settings/developers) and create an OAuth App.
Use your TulipFarm web address for the homepage. Set its authorization callback URL to:

```text
<your public API URL>/api/v1/integrations/auth/callback
```

Copy its client ID and client secret into **Configure personal GitHub access**. This OAuth App must
be separate from the GitHub App above.

## 3. Install it on your repositories

Click **Install it on your repositories**. Creating an App grants nothing on its own — this step
is where you choose which repos TulipFarm may read and write.

Pick **All repositories** or **Only select repositories**, then confirm. TulipFarm records the
installation and the repositories it covers.

After an admin completes this step, each person can select **Connect your GitHub account** on this
page to authorize their personal GitHub access. This does not connect or approve an MCP server.

## What it can do

The App requests the permissions declared by its setup definition — see
[the locked permission set](../../docs/architecture/github-app-manifest.md):

| Permission | Level | Used for |
|---|---|---|
| Contents | Read and write | Read repository content and push a configured Soul backup |
| Issues | Read and write | Receive issue events and deliver replies |
| Pull requests | Read and write | Receive pull request events and deliver replies |
| Checks | Read-only | Receive and inspect check events |
| Metadata | Read-only | Required for every GitHub App |

Repository administration is deliberately **not** requested. TulipFarm asks for it separately, as
an incremental permission update, only if you choose "create the Soul repo for me".

## Changing which repos are covered

Go to the App's page on GitHub → **Configure** → adjust the repository selection. Reconnect from
this page afterwards so TulipFarm picks up the new list.

## Disconnecting

Disconnecting here revokes TulipFarm's record of the installation. To fully remove access, also
uninstall the App from GitHub's installation settings.

Each person's **Disconnect account** action deletes their stored OAuth credential. They can also
revoke the OAuth App from GitHub's application settings to withdraw the provider-side grant.
