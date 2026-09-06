# Connect Twilio

Twilio bills per message, so treat this Connection as spend authority: anything that can call
`twilio_send_sms` can spend money.

## Collect two values

1. **Account SID** — on the [Console dashboard](https://console.twilio.com). It starts with `AC`
   and is not a secret; it says which account every request addresses.
2. **API key** — Console → **Account → API keys & tokens → Create API key**. Copy the key SID
   (`SK…`) and the secret, which Twilio shows only once.

Use an API key rather than the Auth Token. A key can be revoked on its own; revoking the Auth
Token breaks everything else you have connected to Twilio.

## Connect it

Open **Integrations → Twilio → Connect**.

- Paste the Account SID into **Account SID**.
- Paste the key as `SID:SECRET` — for example `SKxxxxxxxx:your-secret` — into **API key SID and
  secret**. Twilio authenticates with HTTP Basic over that pair, so it is stored as one Secret.

## What agents can do

| Tool | What it does |
| --- | --- |
| `twilio_get_account` | Confirms the credential works |
| `twilio_send_sms` | Sends an SMS or WhatsApp message |
| `twilio_list_messages` | Reads message history for the account |

`twilio_list_messages` is a `sensitive_read`: message bodies are in the result.

## Sending

`From` must be a number or Messaging Service the account owns. `To` must be E.164 — `+14155552671`,
not `(415) 555-2671`.

## Rotating the key

Create a new API key, connect it, then delete the old key in the Console.
