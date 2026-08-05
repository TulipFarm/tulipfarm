# Connect Slack

1. Go to https://api.slack.com/apps → **Create New App** → **From a manifest**. Paste the manifest
   shown in the guided setup (or copy it from this integration's Connect flow), pick your
   workspace, and create the app. This pre-configures bot scopes, event subscriptions, and Socket
   Mode — no manual scope-clicking needed.
2. **App-Level Token**: Settings → Basic Information → App-Level Tokens → Generate Token and
   Scopes. Name it "TulipFarm", add the `connections:write` scope, click Generate. Copy it as
   `SLACK_APP_TOKEN` (starts with `xapp-`).
3. **Bot Token**: Settings → Install App → Install to Workspace, approve the scopes, then copy the
   Bot User OAuth Token from OAuth & Permissions as `SLACK_BOT_TOKEN` (starts with `xoxb-`).
4. **Team ID**: this belongs to your workspace, not the app, so it isn't in App Credentials. Open
   your workspace at app.slack.com — the URL looks like `app.slack.com/client/T0XXXXXXX/...`, and
   that `T`-prefixed segment is your Team ID. Copy it as `SLACK_TEAM_ID`.

If you'd rather build the app manually instead of importing a manifest: enable Socket Mode
(Settings → Socket Mode) to mint the app-level token, turn on Agents & AI Apps
(Features → Agents & AI Apps → enable Assistant), add Bot Token Scopes `chat:write`,
`app_mentions:read`, `channels:history`, `im:history`, `users:read`, `users:read.email`,
`assistant:write` (Features → OAuth & Permissions), and turn on
Event Subscriptions (Features → Event Subscriptions, no Request URL needed under Socket Mode)
subscribed to `message.channels`, `message.im`, `app_mention` — then continue from step 3 above.

If you already connected Slack before this app started using the Agents & AI Apps status
indicator, `assistant:write` is a new scope: reinstall the app (Settings → Install App →
Reinstall to Workspace) to re-approve permissions, then reconnect here with the same tokens.
