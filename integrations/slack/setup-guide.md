# Connect Slack

Before starting, open **Business → About** and confirm the **Public address** is the HTTPS address
you use to open TulipFarm. The callback shown there must be reachable from your browser.
TulipFarm deliberately uses one callback path for every Integration; the signed, one-use OAuth
state identifies Slack and the setup step when the provider returns.

1. Select **Create app on Slack** in this Connect flow. Pick your workspace and create the app.
   TulipFarm opens Slack's manifest flow with Socket Mode, Agent messaging, bot scopes, events, and
   the exact OAuth callback already filled in.
2. On Slack's **Settings → Basic Information** page, copy the **Client ID** and **Client Secret**
   into the fields here.
3. On the same page, go to **App-Level Tokens → Generate Token and Scopes**. Name it "TulipFarm",
   add `connections:write`, generate it, and paste the `xapp-` token here.
4. Save the fields, then select **Authorize on Slack**. Approve the workspace install. TulipFarm
   receives the bot token and Team ID from Slack; you do not copy either value by hand.

If you'd rather build the app manually instead of importing a manifest: enable Socket Mode
(Settings → Socket Mode) to mint the app-level token, turn on Agents & AI Apps
(Features → Agents & AI Apps → enable Agent messaging), add Bot Token Scopes `chat:write`,
`app_mentions:read`, `channels:read`, `channels:history`, `groups:read`, `groups:history`,
`im:read`, `im:history`, `mpim:read`, `mpim:history`, `users:read`, `users:read.email`,
`assistant:write` (Features → OAuth & Permissions), and turn on
Event Subscriptions (Features → Event Subscriptions, no Request URL needed under Socket Mode)
subscribed to `message.channels`, `message.im`, `app_mention`. Under **OAuth & Permissions →
Redirect URLs**, add the exact callback shown under TulipFarm's **Business → About → Public
address**, then continue from step 2 above.

If you already connected Slack before this app started using the Agents & AI Apps status
indicator, `assistant:write` is a new scope, and if you connected before conversation indexing
was added, `channels:read`, `groups:read`, `groups:history`, `im:read`, `mpim:read`, and
`mpim:history` are new too: reinstall the app (Settings → Install App → Reinstall to Workspace)
to re-approve permissions, then reconnect here with the same tokens.
