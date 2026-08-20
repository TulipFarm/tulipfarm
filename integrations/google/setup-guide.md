# Connect Google Workspace

One sign-in covers Gmail, Calendar, Drive, and Docs. Connecting is two screens, the same shape as
Slack: paste an OAuth client once, then click **Sign in with Google**. Signing in stores a
self-refreshing token, so the connection keeps working without anyone signing in again.

## 1. Create a Google OAuth client (one time)

Google has no "create app from a manifest" step, so the OAuth client is made by hand in your own
Google Cloud project. It belongs to this deployment — TulipFarm never sees your Google Cloud.

1. In [Google Cloud Console](https://console.cloud.google.com/apis/credentials), open the project
   serving this deployment and enable these APIs from the API Library: **Gmail API**, **Google
   Calendar API**, **Google Drive API**, **Google Docs API**. (See "One client, one token" below —
   this is the only per-product step, and it is unrelated to tokens.)
2. Open the **OAuth consent screen** and pick the **User type**:
   - **Internal** — only offered if this project belongs to a Google **Workspace** organization. It
     skips Google's verification review for the Gmail, Drive, and Docs scopes.
   - **External** — use this for a personal Gmail account (no Workspace). Keep the publishing status
     on **Testing**, then add your own Google account under **Test users**. Restricted scopes work
     for test users with no verification. One caveat: while in **Testing**, Google expires the
     **refresh token after 7 days**, so a fully unattended background routine would need a
     reconnect weekly until the app is published + verified (or moved to a Workspace account). For
     trying this out, Testing is exactly right.
3. Open **Credentials → Create credentials → OAuth client ID**, type **Web application**.
4. Under **Authorized redirect URIs**, add TulipFarm's callback URL — this is where Google sends the
   user back after they approve, and it must match **exactly**. For a default local dev instance it
   is:

   ```
   http://localhost:4010/api/v1/integrations/auth/callback
   ```

   If you set `PUBLIC_API_URL`, use that origin instead, keeping the same
   `/api/v1/integrations/auth/callback` path. The TulipFarm connect screen also displays the exact
   value — copy it from there if unsure. A trailing slash or scheme mismatch is the most common
   cause of a failed sign-in. (Google allows `http://localhost` redirect URIs for local testing.)
5. Copy the **Client ID** and **Client secret**.

## One client, one token — not one per product

You create **one** OAuth client (a single Client ID + secret); it is **not** per API. Signing in
once issues **one** token that carries every granted scope, so the same token reaches Gmail,
Calendar, Drive, and Docs — there is no separate token to create per product. The only per-product
step is **enabling each API** in the Cloud project (a one-time toggle in the API Library), which
governs whether a call is allowed, not authentication. Enabling all four now avoids a surprise
later when the agent first touches one.

## 2. Connect in TulipFarm

1. Paste the **Client ID** and **Client secret** into the first connect screen.
2. Click **Sign in with Google** and approve the access.

TulipFarm stores a refresh token (the sign-in requests offline access) and swaps the short-lived
access token for a fresh one before it expires.

## What the agent can do

This one connection backs code-backed Google Tools:

- **Gmail** — search and read mail, compose a draft, send.
- **Calendar** — list events, create an event.
- **Drive** — search and read files, create a file.
- **Docs** — read a document, create one, insert or replace text.

Read tools run freely; write tools (draft, send, create event, create file, edit doc) are
approval-gated — the agent proposes the write and you approve it before it happens.

## Scopes

The sign-in requests every scope the tools need up front, so new tools can be added without asking
you to reconnect:

- `gmail.modify`, `gmail.send` — read mail, create drafts, send.
- `calendar` — read and create events.
- `drive` — read and create files.
- `documents` — read and edit documents.

Gmail, Drive, and Docs scopes are "restricted" to Google; an **Internal** consent screen is what
lets you use them without submitting the app for Google verification.
