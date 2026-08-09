# Connect Telegram

The guided Connect flow does all of this. This page is the manual equivalent, and the place to look
when something behaves unexpectedly.

1. **Create the bot.** Open [@BotFather](https://t.me/BotFather) in Telegram and send `/newbot`.
   Give it a display name, then a username ending in `bot` (for example `tulipfarm_bot`). BotFather
   replies with a token shaped like `123456789:AAEhBOweik6ad-3qUiw` — that is
   `TELEGRAM_BOT_TOKEN`. Anyone holding it controls the bot, so treat it as a password.
2. **Copy the username.** The `@handle` you chose is `TELEGRAM_BOT_USERNAME`, without the leading
   `@`. TulipFarm needs it because a Telegram update never names the bot it was sent to, so this is
   how mentions of *this* bot are told apart from mentions of anything else.
3. **Turn off privacy mode** — only if you want the bot to answer in groups. Send `/setprivacy` to
   BotFather, pick your bot, and choose **Disable**. With privacy enabled (Telegram's default),
   Telegram forwards only messages that start with a `/command`, so plain `@mentions` never arrive
   and the bot looks broken in groups. Direct messages work either way.
4. **Register the webhook.** The Connect flow does this for you, generates the delivery secret, and
   stores it as `TELEGRAM_WEBHOOK_SECRET`. It requires a publicly reachable HTTPS URL — Telegram
   will not deliver to `localhost` or to plain HTTP.

## Using it

- **Direct message**: message the bot. Every message in a DM is treated as addressed to it, except
  `/start`, which is Telegram's own onboarding tap rather than a question.
- **Group**: add the bot to the group, then `@mention` it. Replying to something the bot said
  continues the exchange without a fresh mention.
- **Forum topics**: each topic is its own conversation, and answers are posted back into the topic
  they came from.

Messages that are not addressed to the bot are ignored rather than answered — a bot that replied to
every message in a room would be unusable in one.

## Troubleshooting

- **Nothing arrives at all.** Telegram allows one webhook per bot. If the same token is registered
  by another deployment, that one wins. Reconnect here to take the registration back.
- **DMs work, group mentions do not.** Privacy mode is still enabled — step 3.
- **Deliveries are rejected.** The secret Telegram echoes back no longer matches the stored one,
  which happens when the webhook was re-registered elsewhere. Reconnect to regenerate both halves
  together.
- **The bot answers a stranger's old message on first connect.** It should not: registration drops
  Telegram's pending backlog. If you see this, the webhook was registered outside TulipFarm.
- **Senders show as unlinked.** Telegram never exposes a user's email, so a sender cannot be matched
  to a TulipFarm account automatically. They bind their account once, from the link the bot offers.
