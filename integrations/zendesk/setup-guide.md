# Connect Zendesk

This package uses a Zendesk API token for one Zendesk Support account. API tokens are supported for
internal integrations, but Zendesk marks them deprecated in favor of OAuth. A distributed app must
use Zendesk global OAuth instead.

## Provider setup

1. In Admin Center, open **Apps and integrations → APIs → Zendesk API**.
2. Enable token access and create an API token.
3. Choose the verified agent or admin account whose permissions the Connection should carry.
4. Enter the credential as `email@example.com/token:api-token`.

API tokens do not have granular scopes. Access is limited by the authenticated agent's role,
ticket restrictions, groups, brands, and other Zendesk permissions. Use a least-privilege agent.

## Connect it

Open **Integrations → Zendesk → Connect**, enter the full account URL, and paste the combined
credential. For example, enter `https://acme.zendesk.com`. TulipFarm stores only the normalized
host, applies HTTP Basic encoding, and sends the credential only to that account's
`*.zendesk.com` host.

## Operations

| Tool | Access |
| --- | --- |
| `zendesk_current_user` | Identify the authenticated agent |
| `zendesk_list_users` | List users with page-based pagination |
| `zendesk_get_user` | Read one user |
| `zendesk_list_tickets` | List tickets with page-based pagination |
| `zendesk_get_ticket` | Read one ticket |
| `zendesk_search` | Search tickets, users, and organizations |
| `zendesk_create_ticket` | Create a ticket and its first comment |
| `zendesk_update_ticket` | Update fields and optionally add a public reply or private note |

Zendesk recommends cursor pagination, but its query names use `page[size]` and `page[after]`, which
the current OIM parameter-name grammar cannot express. These list Tools therefore use supported
offset pagination. Zendesk caps deep offset access; use narrower searches for large datasets.
Ticket comments are append-only. Updating a ticket adds a new comment; it does not edit an old one.

## Events

No events are declared. Zendesk trigger webhooks can send administrator-defined payload templates,
while OIM event types require a stable selector and payload schema. This package does not invent a
provider event contract that Zendesk does not guarantee.

## Official references

- [Security and authentication](https://developer.zendesk.com/api-reference/introduction/security-and-auth/)
- [Users API](https://developer.zendesk.com/api-reference/ticketing/users/users/)
- [Tickets API](https://developer.zendesk.com/api-reference/ticketing/tickets/tickets/)
- [Search API](https://developer.zendesk.com/api-reference/ticketing/ticket-management/search/)
- [Cursor pagination](https://developer.zendesk.com/documentation/api-basics/pagination/paginating-through-lists-using-cursor-pagination/)
