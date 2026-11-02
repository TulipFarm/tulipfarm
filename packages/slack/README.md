# @tulipfarm/slack

Slack installation, event intake, delivery and Block Kit checks for TulipFarm.

## Slack app settings

Configure the Slack app at [api.slack.com/apps](https://api.slack.com/apps).
Bot scopes come from `SLACK_CONFIGURATION` plus the flag-dependent scopes in
`requiredBotScopes`. A scope change needs the workspace to reconnect Slack from
TulipFarm's integration settings, so TulipFarm stores the new token. Reinstalling
from Slack's own **Install App** page creates a token TulipFarm never receives.

| Setting                            | Value                                                                                                                                                                                                                               |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Event Subscriptions request URL    | `<api origin>/v1/slack/events`                                                                                                                                                                                                      |
| Bot events                         | `app_mention`, `message.channels`, `message.groups`, `message.im`, `message.mpim`, `app_uninstalled`, `tokens_revoked`                                                                                                              |
| Bot events, `generative-ui` flag   | `assistant_thread_started` for suggested prompts in the agent view, and `app_home_opened` for the Home tab                                                                                                                          |
| Bot events, `slack-reactions` flag | `reaction_added`                                                                                                                                                                                                                    |
| Bot events, ⏰ follow-ups          | `reaction_added` and `reaction_removed`, so an `:alarm_clock:` reaction sets a one-hour reminder and removing it cancels the reminder. Both need the `reactions:read` bot scope in `SLACK_CONFIGURATION` `scopeApproval.botScopes`. |
| Interactivity request URL          | `<api origin>/v1/slack/actions`, for buttons, choices, forms, modals and feedback in replies                                                                                                                                        |
| App Home                           | Turn on **Home Tab**, and **Messages Tab** for direct messages. Without the Home tab, or without `app_home_opened`, Slack shows its own "work in progress" page instead of TulipFarm's welcome.                                     |
| Agents & AI Apps                   | Turn on for the agent view, streamed progress and thread titles. It needs the `assistant:write` scope.                                                                                                                              |

Event subscriptions and App Home settings take effect when saved; they don't
need a reconnect unless Slack also asks for new scopes.

### Follow-ups in Slack

A mention or direct message such as "in 10 minutes remind @asha here" lets the
default agent schedule a follow-up with `followups.schedule`. When it is due,
the agent answers again in the same thread as the person who asked. A channel
thread reply shows the follow-up with a **Cancel follow-up** button, handled by
the existing interactivity URL. Direct messages show no button; ask the agent
to cancel instead.

An `:alarm_clock:` reaction on a message in a channel where the app is present
reminds the person who reacted in that message's thread one hour later. Only a
linked TulipFarm member can set one; reactions from anyone else are ignored.
Slack sends the reacting person a private confirmation with a Cancel button,
and removing the reaction before the reminder runs cancels it. A channel's own
`alarm_clock` reaction rule takes priority over the reminder.

Add `reactions:read` to `scopeApproval.botScopes`, subscribe to
`reaction_added` and `reaction_removed`, then reconnect Slack from TulipFarm's
integration settings. Without them, mention and direct-message follow-ups still
work.
