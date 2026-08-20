# Connect Google Workspace

One sign-in covers Gmail, Calendar, Drive, and Docs. Connecting is two screens, the same shape as
Slack: paste an OAuth client once, then click **Sign in with Google**. Signing in stores a
self-refreshing token, so the connection keeps working without anyone signing in again.

## 1. Create a Google OAuth client (one time)

Google has no "create app from a manifest" step, so the OAuth client is made by hand in your own
Google Cloud project. It belongs to this deployment — TulipFarm never sees your Google Cloud.

1. In [Google Cloud Console](https://console.cloud.google.com/apis/credentials), open the project
   serving this deployment and enable these APIs from the API Library: **Gmail API**, **Google
   Calendar API**, **Google Drive API**, **Google Docs API**.
2. Open **OAuth consent screen** and set **User type** to **Internal**. Internal keeps the app to
   your own Workspace and skips Google's verification review for the Gmail, Drive, and Docs scopes.
   (Choose External only if the accounts live outside your Workspace; Google will then require
   verification before those scopes work for anyone but named test users.)
3. Open **Credentials → Create credentials → OAuth client ID**, type **Web application**.
4. Under **Authorized redirect URIs**, add the callback URL shown on the TulipFarm connect screen,
   exactly. A trailing-slash or scheme mismatch is the most common cause of a failed sign-in.
5. Copy the **Client ID** and **Client secret**.

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
