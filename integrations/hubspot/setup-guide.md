# Connect HubSpot

HubSpot issues tokens only to an app **you** own. TulipFarm never ships a client id, so your
instance's API traffic is attributed to your app, counts against your quota, and cannot be affected
by anyone else's misuse.

## Create the app

1. Open <https://developers.hubspot.com> and create a developer account if you have none.
2. **Apps → Create app**, name it (for example `TulipFarm`).
3. On the **Auth** tab, add this redirect URL, replacing the host with your own:

   ```text
   https://YOUR-TULIPFARM-HOST/api/v1/integrations/oim/auth/callback
   ```

4. Under **Scopes**, select `oauth`, `crm.objects.contacts.read`, `crm.objects.contacts.write`,
   `crm.objects.companies.read` and `crm.objects.companies.write`. HubSpot refuses the
   authorization if the app does not offer every scope this package requests.
5. Copy the **Client ID** and **Client secret**.

## Connect it

1. Open **Integrations → HubSpot → Connect**.
2. Paste the client id and client secret, then save. The connection is created but not yet
   authorized.
3. Choose **Authorize**. HubSpot asks which account to install the app on and shows the scopes
   before it issues a token.
4. You land back on the connections page. Choose **Test** to confirm the token works.

## Personal versus business

Create the Connection as **Business** for a shared account every agent may act through, or as
**Personal** to have agents act as you. A personal connection spends only your own token.

## What agents can do

| Tool | What it does |
| --- | --- |
| `hubspot_list_contacts` | Lists CRM contacts, paging through them |
| `hubspot_get_contact` | Reads one contact by id |
| `hubspot_create_contact` | Creates a contact |
| `hubspot_update_contact` | Updates property values on one contact |
| `hubspot_get_company` | Reads one company by id |
| `hubspot_create_company` | Creates a company |

## When it stops working

HubSpot access tokens are short-lived. If **Test** reports that the connection needs attention,
choose **Authorize** again — the app and its credentials stay as they are, and only the token is
reissued.
