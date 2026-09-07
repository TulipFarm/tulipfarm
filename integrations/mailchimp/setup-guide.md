# Connect Mailchimp

This Integration uses Mailchimp Marketing API version 3.0 with an account API key.

## Get the connection values

1. In Mailchimp, open **Profile → Extras → API keys** and create a key for TulipFarm.
2. Read the data-center suffix at the end of the key, such as `us21`.
3. Form the API host `<data-center>.api.mailchimp.com`, such as `us21.api.mailchimp.com`.
4. Store the credential as `tulipfarm:<api-key>`. Mailchimp ignores the Basic-auth username but
   requires a non-empty value before the colon.

Open **Integrations → Mailchimp → Connect**, enter the full API host, and paste that credential.
TulipFarm base64-encodes it for `Authorization: Basic ...`; do not encode it yourself.

The destination allowlist accepts only `*.api.mailchimp.com`. The current OIM origin template
replaces a whole host, not one subdomain label, so the field takes the full host rather than only
`us21`.

## What agents can do

| Tool | Effect |
| --- | --- |
| `mailchimp_get_account` | read account identity |
| `mailchimp_list_audiences` | read audience metadata |
| `mailchimp_list_members` | sensitive read of audience members |
| `mailchimp_add_member` | create an audience member |
| `mailchimp_update_member` | update an audience member |
| `mailchimp_list_campaigns` | read campaign metadata |
| `mailchimp_create_campaign` | create a campaign draft |
| `mailchimp_update_campaign` | update a campaign draft |

Creating or updating a campaign does not send it. Sending and scheduling are deliberately outside
this launch package.

Mailchimp calls lists “audiences” in the product, while the stable API paths remain `/lists`.
`mailchimp_list_members` returns each member's `id`; use that value as `subscriber_hash` for an
update. It is Mailchimp's MD5 hash of the lowercase email address.

List endpoints use `count` plus `offset`. Increase `offset` by the number of returned items until it
reaches `total_items`. OIM has page-number and cursor pagination but no offset-plus-count model, so
pagination stays explicit rather than being declared incorrectly.

## Offline fixtures

The package's fixtures use `us21.api.mailchimp.com` only as deterministic configuration for the
recording transport. They never open a network connection or use a stored API key.

## Sources

- https://mailchimp.com/developer/marketing/docs/fundamentals/
- https://api.mailchimp.com/schema/3.0/Swagger.json
- https://mailchimp.com/developer/marketing/docs/quick-start/
