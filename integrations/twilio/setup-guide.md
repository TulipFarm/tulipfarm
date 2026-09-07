# Connect Twilio

Twilio bills per message, so treat this Connection as spend authority: anything that can call
`twilio_send_sms` can spend money.

## Collect the API values

1. **Account SID** — on the [Console dashboard](https://console.twilio.com). It starts with `AC`
   and is not a secret; it says which account every request addresses.
2. **API key** — Console → **Account → API keys & tokens → Create API key**. Copy the key SID
   (`SK…`) and the secret, which Twilio shows only once.

Use an API key rather than the Auth Token for API calls. A key can be revoked on its own; revoking
the Auth Token breaks everything else you have connected to Twilio. Webhook verification still
needs the Auth Token because [Twilio signs callbacks with it](https://www.twilio.com/docs/usage/security#validating-requests).

## Connect it

Open **Integrations → Twilio → Connect**.

- Paste the Account SID into **Account SID**.
- Paste the key as `SID:SECRET` — for example `SKxxxxxxxx:your-secret` — into **API key SID and
  secret**. Twilio authenticates with HTTP Basic over that pair, so it is stored as one Secret.
- To receive webhooks, also paste the account's **Auth Token** into **Account Auth Token**. Twilio
  uses that token only to sign callbacks; it is not the API key secret.

## What agents can do

| Tool | What it does |
| --- | --- |
| `twilio_get_account` | Confirms the credential works |
| `twilio_send_sms` | Sends an SMS or WhatsApp message |
| `twilio_list_messages` | Reads message history for the account |

`twilio_list_messages` is a `sensitive_read`: message bodies are in the result.
Each non-empty history page returns an opaque `next_page_token`. Pass that back as `page_token`.
An empty page means pagination is complete; agents never construct Twilio page numbers.

## Sending

Set either `From` to a sender the account owns or `MessagingServiceSid` to an `MG…` service whose
sender pool should choose the sender. `To` must be E.164 — `+14155552671`, not `(415) 555-2671`.

## Incoming messages and status callbacks

Set the phone number's incoming-message webhook or a Messaging Service's status callback to the
exact callback URL generated for this Connection. It ends with
`/api/v1/hooks/oim/twilio?connectionId=…`. Copy the whole HTTPS URL, including the query string,
and use `POST`.

TulipFarm verifies `X-Twilio-Signature` with the Account Auth Token and the exact configured public
callback URL. It decodes every form field, sorts names and repeated values using Twilio's documented
rules, and only then accepts `message.received` or `message.status_changed`.

Do not replace the hostname or remove the `connectionId`. The signed URL must match the generated
callback URL exactly, including any port or query string.

## Rotating the key

Create a new API key, connect it, then delete the old key in the Console. Rotating the Account Auth
Token also requires updating **Account Auth Token** before Twilio callbacks verify again.
