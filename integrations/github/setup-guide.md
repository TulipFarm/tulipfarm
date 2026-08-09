# Connect GitHub

Two clicks. TulipFarm creates the GitHub App for you and receives its credentials directly from
GitHub — you never copy an App ID, a private key, or a webhook secret by hand.

## 1. Create the App

Click **Create the GitHub App**. You'll land on GitHub with the App's name, permissions, webhook
URL, and callback already filled in from
[`manifest.yml`](manifest.yml). Review it, pick the account or organization that should own the
App, and confirm.

GitHub sends you straight back, and TulipFarm stores the App ID, slug, private key, webhook
secret, and OAuth client credentials automatically.

> The App belongs to **you**, not to TulipFarm. There is no shared vendor-owned App: the private
> key is generated for your deployment and never leaves it.

## 2. Install it on your repositories

Click **Install it on your repositories**. Creating an App grants nothing on its own — this step
is where you choose which repos TulipFarm may read and write.

Pick **All repositories** or **Only select repositories**, then confirm. TulipFarm records the
installation and the repos it covers, and GitHub Tools become available to your agents.

## What it can do

The App requests only what the agents need — see
[the locked permission set](../../docs/architecture/github-app-manifest.md):

| Permission | Level | Used for |
|---|---|---|
| Contents | Read and write | Read files, commit and push agent-authored changes |
| Issues | Read and write | Search, comment, label, assign, close |
| Pull requests | Read and write | Create, review, comment, merge |
| Checks | Read-only | Read CI status for PR gating |
| Metadata | Read-only | Required for every GitHub App |

Repository administration is deliberately **not** requested. TulipFarm asks for it separately, as
an incremental permission update, only if you choose "create the Soul repo for me".

## Changing which repos are covered

Go to the App's page on GitHub → **Configure** → adjust the repository selection. Reconnect from
this page afterwards so TulipFarm picks up the new list.

## Disconnecting

Disconnecting here revokes TulipFarm's record of the installation. To fully remove access, also
uninstall the App from GitHub's installation settings.
