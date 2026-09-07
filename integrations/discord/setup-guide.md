# Connect Discord

This package uses Discord's HTTP API with a bot token. It does not automate a normal user account,
open a Gateway connection, or pretend to provide real-time message events.

## Provider setup

1. In the [Discord Developer Portal](https://discord.com/developers/applications), create an
   application and add a bot.
2. Reset or copy the bot token from the **Bot** page.
3. Use **OAuth2 → URL Generator** with the `bot` scope to install it in each server it should
   access.
4. Grant only the channel permissions needed by these Tools:
   - **View Channels** to list visible channels and read from them.
   - **Read Message History** to list messages.
   - **Send Messages** to send messages.
5. Enable the **Message Content Intent** when the bot must read message text. Discord may require
   approval for verified apps.

The bot sees only servers where it is installed and channels allowed by Discord permissions.
Discord bot tokens do not have OAuth user scopes. This package never accepts user tokens or
self-bot credentials.

## Connect it

Open **Integrations → Discord → Connect** and paste the bot token. TulipFarm stores it as a Secret
and sends `Authorization: Bot …` only to `discord.com`.

## Operations

| Tool | Access |
| --- | --- |
| `discord_current_user` | Identify the connected bot |
| `discord_list_guilds` | List servers containing the bot |
| `discord_list_channels` | List channels visible in one server |
| `discord_list_messages` | Read one page of channel messages |
| `discord_send_message` | Send a text message |
| `discord_edit_message` | Edit a message authored by this bot |

Message listing supports Discord's `before`, `after`, and `around` snowflake cursors. Supply only
one cursor at a time. Sending and editing use plain JSON text only; attachments and components are
outside this launch package.

## Events

No events are declared. Normal Discord message events arrive over the persistent Gateway
WebSocket, while OIM events currently accept HTTP deliveries only. Discord interactions can use
signed HTTP delivery, but the current credential schema has no public-key credential kind for the
application's Ed25519 public key.

## Official references

- [Authentication](https://docs.discord.com/developers/reference#authentication)
- [Current user and guilds](https://docs.discord.com/developers/resources/user)
- [Guild channels](https://docs.discord.com/developers/resources/guild#get-guild-channels)
- [Channel messages](https://docs.discord.com/developers/resources/message#get-channel-messages)
- [Create and edit messages](https://docs.discord.com/developers/resources/message#create-message)
- [Gateway](https://docs.discord.com/developers/events/gateway)
