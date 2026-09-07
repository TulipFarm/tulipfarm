# Connect the Slack OIM API reference

This is the portable Web API, ACL-preserving Knowledge, and signed Events reference. It is
**not** a replacement for the existing `slack` Socket Mode channel connector yet.

Create a Slack app from the official app-manifest flow. Use this app manifest, replacing the
request URL with your public TulipFarm URL followed by
`/api/v1/hooks/oim/slack-oim?connectionId=YOUR_CONNECTION_ID`:

```json
{
  "display_information": {
    "name": "TulipFarm OIM"
  },
  "features": {
    "bot_user": {
      "display_name": "TulipFarm OIM",
      "always_online": true
    },
    "agent_view": {
      "agent_description": "Talk to TulipFarm agents from Slack."
    }
  },
  "oauth_config": {
    "redirect_urls": [
      "https://YOUR-TULIPFARM-HOST/api/v1/integrations/oim/auth/callback"
    ],
    "scopes": {
      "bot": [
        "chat:write",
        "app_mentions:read",
        "channels:read",
        "channels:history",
        "groups:read",
        "groups:history",
        "im:read",
        "im:history",
        "mpim:read",
        "mpim:history",
        "users:read",
        "users:read.email",
        "assistant:write",
        "reactions:write",
        "emoji:read"
      ]
    }
  },
  "settings": {
    "event_subscriptions": {
      "request_url": "https://YOUR-TULIPFARM-HOST/api/v1/hooks/oim/slack-oim?connectionId=YOUR_CONNECTION_ID",
      "bot_events": [
        "message.channels",
        "message.groups",
        "message.im",
        "message.mpim",
        "app_mention"
      ]
    },
    "interactivity": {
      "is_enabled": false
    },
    "org_deploy_enabled": false,
    "socket_mode_enabled": false,
    "token_rotation_enabled": false
  }
}
```

Then:

1. Copy the Client ID, Client Secret, and Signing Secret from **Basic Information**.
2. Create the organization OIM Connection and enter the app values.
3. Authorize the Slack OAuth step to store the bot token.
4. After the Connection exists, replace `YOUR_CONNECTION_ID` in Slack's Event Subscriptions
   Request URL with that Connection ID. Slack's URL challenge and signed deliveries use the OIM
   Events profile.

For Socket Mode channel conversations, install the separate `slack` Integration. A `slack-oim`
Connection is not attached to that legacy channel path, and installing this package does not
replace or reconfigure an existing Slack connector.

The portable Knowledge profile can discover visible conversations, list and retrieve messages,
preserve conversation membership as source ACLs, and recheck a linked Slack user's membership
before retrieval. Select conversations when creating the Knowledge source.

Current limits:

- Personal Slack OAuth is not included. OIM Auth 1.0 cannot safely express Slack's optional
  `user_scope` flow as an alternative to the shared bot install, so this package exposes bot
  operations only.
- Channel migration is incomplete. This package does not provide an attachment endpoint that
  safely binds one exact OIM Connection to the legacy Socket Mode channel host.
- The fixture suite is offline and redacted. No live Slack credential certification was run.
