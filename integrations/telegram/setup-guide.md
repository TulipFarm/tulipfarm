# Connect Telegram

Telegram agents act as a **bot**, not as you. A bot only sees messages sent directly to it, or sent
in a group after you add it — it can never read your personal chats.

## Create the bot

1. In Telegram, message [@BotFather](https://t.me/BotFather).
2. Send `/newbot` and answer the two prompts (a display name, then a username ending in `bot`).
3. BotFather replies with a token like `123456789:AAExampleTokenValue`. Copy it.
4. Send `/setprivacy` → your bot → **Disable** only if the bot must read every group message.
   Leave it enabled and the bot sees only messages that mention it or reply to it.

## Connect it

Open **Integrations → Telegram → Connect** and paste the token.

The token is stored as a Secret and placed in the request URL at call time. It never appears in a
prompt, a Tool argument, a Tool result, or the compiled Tool definition.

## What agents can do

| Tool | What it does |
| --- | --- |
| `telegram_get_me` | Confirms which bot the connection authenticates as |
| `telegram_send_message` | Sends a text message to a chat the bot belongs to |
| `telegram_get_updates` | Reads recent messages sent to the bot |

`telegram_send_message` is a `send` effect, so it is subject to approval like any other outbound
message.

## Finding a chat id

Add the bot to the group, send it any message, then run `telegram_get_updates`. The `chat.id` in
the result is what `telegram_send_message` needs. Group ids are negative — keep the minus sign.

## Rotating the token

Send `/revoke` to BotFather, then paste the new token over the old Connection. The old token stops
working immediately.
