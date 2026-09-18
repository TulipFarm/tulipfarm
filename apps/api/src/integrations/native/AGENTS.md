# Native channels

Slack/GitHub channel setup, verified ingress and durable dispatch. Not an Agent Tool catalog.

## Read on / Skip

- **Read on** for native webhook setup, Socket Mode event handoff or reply authorization.
- **Skip** for MCP accounts and business Tools; use sibling `accounts/` and `mcp-compose.ts`.

## Map

| Path | Owns |
| --- | --- |
| `compose.ts` | Real repositories, native credentials and live Agent-use checks. |
| `routes.ts` | Admin route/grant setup and raw-byte public webhook endpoints. |
| `service.ts` | Persist-before-ack, leased dispatch, linked-user reauthorization and Routine bindings. |
| `credentials.ts` | Native signing secrets and repository-scoped GitHub installation reply tokens. |
| `../../internal/native-channel-routes.ts` | Worker drain, Socket Mode intake, reply authorization and credentials. |

## Rules

- Native credentials never become business Tools or MCP account fallbacks.
- Bundled setup uses fields, App manifests, installation and OAuth; generic webhook registration is denied.
- Human shared-channel Turns retain the linked sender and shared audience in request metadata.
- Slash commands and Surface answers persist sanitized verified sender input before ack; response
  URLs stay in the existing sealed command-response queue, never the native inbox.
- Accepted events pin route/grant state; replay and reply recheck the current linked user.
- Automated events require a live, exact published Routine approval; no assumed human identity.
- Routine Run creation and the fenced inbox binding commit together, before Worker admission.
- A disabled Routine route may be saved with null authority before account approval. Enabling
  requires the live authority callback; enabled state and saved authority are not approval inputs.
- Register internal guards in the same Fastify scope as channel routes. Legacy caller-supplied
  principal minting is denied; Socket Mode submits its verified envelope to the durable inbox.
