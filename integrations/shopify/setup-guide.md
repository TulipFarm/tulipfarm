# Connect Shopify

This Integration uses Shopify's GraphQL Admin API at version `2026-07`. It does not use the legacy
REST Admin API.

## Before connecting

Create an app for the store in Shopify's Dev Dashboard or with Shopify CLI, authorize it for the
store, and obtain that installation's Admin API access token. TulipFarm does not create or certify
the Shopify app. The current OIM Auth profile cannot express Shopify's shop-specific OAuth
authorization URL, so the authorization flow must be completed outside TulipFarm before connecting.

Grant only the scopes needed:

- `read_products` for product reads, or `write_products` for product reads and writes.
- `read_orders` for orders from Shopify's default 60-day window.
- `read_all_orders` only after Shopify approves that extra access and older orders are required.
- `read_customers` for customer reads, or `write_customers` for customer reads and writes.

Customer data is protected data. Complete Shopify's protected customer data review before granting
customer scopes. The staff member authorizing the app must also have the matching Shopify
permissions.

## Connect it

Open **Integrations → Shopify → Connect**.

1. Enter the exact `*.myshopify.com` host, for example `muskan-store.myshopify.com`.
2. Paste the Admin API access token for that store.

The destination allowlist accepts only `*.myshopify.com`. The API version is fixed in every path,
and the token is sent only in `X-Shopify-Access-Token`.

## What agents can do

| Tool | Effect | Required Shopify access |
| --- | --- | --- |
| `shopify_get_shop` | read | authenticated Admin API access |
| `shopify_list_products` | read | `read_products` or `write_products` |
| `shopify_get_product` | read | `read_products` or `write_products` |
| `shopify_create_product` | create | `write_products` and create-product staff permission |
| `shopify_update_product` | update | `write_products` and update-product staff permission |
| `shopify_list_orders` | sensitive read | `read_orders` or `write_orders` |
| `shopify_get_customer` | sensitive read | `read_customers` or `write_customers` |
| `shopify_update_customer` | update | `write_customers` |

Product creation makes an unpublished product. Publishing and variant bulk changes are not in this
launch package.

For paged product and order reads, pass `first` from 1 to 100. When `hasNextPage` is true, pass the
returned `endCursor` as `after`.

Shopify can return HTTP 200 for a rejected query or mutation. The package declares top-level
`errors` and mutation `userErrors` invalid when non-empty. Treat a mutation as successful only
when TulipFarm returns a confirmed effect.

## Fixed GraphQL operations

Each Tool executes one reviewed, digest-pinned GraphQL document from `operations/`. Agents provide
only the declared variables. They cannot replace the document, operation name, API version or
destination.

The package's offline fixtures use the inert host `fixture-store.myshopify.com` through fixture
configuration. The recording transport never opens a network connection or uses a stored Secret.

Shopify limits GraphQL by calculated query cost. OIM currently models request counts, not cost
points, so the manifest does not invent a request-rate limit.

## Sources

- https://shopify.dev/docs/api/admin-graphql/2026-07
- https://shopify.dev/docs/api/usage/versioning
- https://shopify.dev/docs/api/usage/access-scopes
- https://shopify.dev/docs/apps/launch/protected-customer-data
