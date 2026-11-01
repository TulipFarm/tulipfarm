# @tulipfarm/slack

Slack installation, event intake, delivery and Block Kit checks for TulipFarm.

## Slack app settings

Configure the Slack app at [api.slack.com/apps](https://api.slack.com/apps).
Bot scopes come from `SLACK_CONFIGURATION` plus the flag-dependent scopes in
`requiredBotScopes`. A scope change needs the workspace to reconnect Slack from
TulipFarm's integration settings, so TulipFarm stores the new token. Reinstalling
from Slack's own **Install App** page creates a token TulipFarm never receives.

| Setting                            | Value                                                                                                                                                                                           |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Event Subscriptions request URL    | `<api origin>/v1/slack/events`                                                                                                                                                                  |
| Bot events                         | `app_mention`, `message.channels`, `message.groups`, `message.im`, `message.mpim`, `app_uninstalled`, `tokens_revoked`                                                                          |
| Bot events, `generative-ui` flag   | `assistant_thread_started` for suggested prompts in the agent view, and `app_home_opened` for the Home tab                                                                                      |
| Bot events, `slack-reactions` flag | `reaction_added`                                                                                                                                                                                |
| Interactivity request URL          | `<api origin>/v1/slack/actions`, for buttons, choices, forms, modals and feedback in replies                                                                                                    |
| App Home                           | Turn on **Home Tab**, and **Messages Tab** for direct messages. Without the Home tab, or without `app_home_opened`, Slack shows its own "work in progress" page instead of TulipFarm's welcome. |
| Agents & AI Apps                   | Turn on for the agent view, streamed progress and thread titles. It needs the `assistant:write` scope.                                                                                          |

Event subscriptions and App Home settings take effect when saved; they don't
need a reconnect unless Slack also asks for new scopes.
