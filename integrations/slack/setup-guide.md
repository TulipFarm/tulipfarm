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

## Channel access

The native Slack connection receives messages and delivers agent replies. It does not add
third-party agent Tools, and Slack content is not supported for Knowledge sync.

## Manual Slack app setup

If you'd rather build the app manually instead of importing a manifest: enable Socket Mode
(Settings → Socket Mode) to mint the app-level token, turn on Agents & AI Apps
(Features → Agents & AI Apps → enable Agent messaging), add Bot Token Scopes `chat:write`,
`commands`, `app_mentions:read`, `channels:read`, `channels:history`, `groups:read`,
`groups:history`, `im:read`, `im:history`, `mpim:read`, `mpim:history`, `users:read`,
`assistant:write`, `bookmarks:read`, `bookmarks:write`, `files:read`, `files:write`, `pins:read`,
`pins:write`, `reactions:read`, `reactions:write`, and `emoji:read`
(Features → OAuth & Permissions). Turn on Interactivity
(Features → Interactivity & Shortcuts, no Request URL needed under Socket Mode), then turn on
Event Subscriptions (Features → Event Subscriptions, no Request URL needed under Socket Mode).
Subscribe to `message.channels`, `message.groups`, `message.im`, `message.mpim`, `app_mention`,
`app_home_opened`, `assistant_thread_started`, `assistant_thread_context_changed`,
`app_context_changed`, `reaction_added`, `reaction_removed`, `channel_created`, `channel_rename`,
`channel_archive`, `channel_unarchive`, `member_joined_channel`, `member_left_channel`,
`file_shared`, `file_deleted`, `team_join`, `user_change`, `user_profile_changed`, and
`emoji_changed`. Under **OAuth & Permissions → Redirect URLs**, add the exact callback shown under
TulipFarm's **Business → About → Public address**, then continue from step 2 above.

If you already connected Slack before these scopes were added, reinstall the app
(Settings → Install App → Reinstall to Workspace) to re-approve permissions, then reconnect here
with the same tokens.
