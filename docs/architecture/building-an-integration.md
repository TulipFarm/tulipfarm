# Building an Integration

How to add a provider — Telegram, Discord, Teams, Google Workspace, Confluence, Jira, Notion —
without writing TypeScript.

An integration is a directory containing a `manifest.yml`, an optional OpenAPI document, and an
optional `setup-guide.md`. That directory can ship in this repo (`integrations/<slug>/`) or live in
any git repo an operator installs by URL. There is no third path: **installing an integration
never means running someone's code.** Everything a provider needs — how its app is created, how
credentials are obtained, which API calls agents may make — is expressed as data.

[`integrations/notion/`](../../integrations/notion/) is the reference for a read/write integration:
a manifest and an OpenAPI document, no TypeScript, eight working agent Tools.
[`integrations/telegram/`](../../integrations/telegram/) is the reference for a **channel** — the
same, plus a sandboxed classifier, yielding a bot that holds conversations.

## The three parts of a manifest

| Block | Answers | Required |
|---|---|---|
| identity (`name`, `version`, `description`, `icon`, `capabilities`, `grants`) | What is this and what will it be allowed to do? | `name`, `version`, `description` |
| `auth` | How does an operator connect it? | yes, unless `egress.type: none` |
| `egress` | What may agents *do* once connected? | yes |
| `ingress` | What arrives *from* the provider, and what does it mean? | only for channels |

## Egress — turning a provider API into agent Tools

```yaml
egress:
  type: openapi
  spec: openapi.json          # a file in this directory
  base_url: https://api.notion.com/v1
  auth:
    token_env: NOTION_ACCESS_TOKEN   # a connection env var, sealed at connect time
  headers:
    Notion-Version: "2022-06-28"
  operations:
    - operation: search       # operationId in the spec
      name: search            # agents call this as <slug>_search
      description: Search Notion for pages and databases by title. Use this first when you
        know a page by name but not by id.
      mutating: false
```

At boot — and again the moment an operator connects — the runtime reads the spec, compiles each
named operation into a Tool with a JSON Schema derived from the operation's parameters and request
body, and registers it. Nothing else is required.

### `operations` is an allowlist, and that is deliberate

A real provider spec carries dozens of operations. Publishing all of them is both unusable for a
model and far more authority than any integration needs. **Absent or empty publishes nothing** — an
integration with no `operations` connects successfully and grants zero Tools.

Choose the smallest set that makes the integration useful, and write each `description` for the
model that reads it. The description is how an agent decides which Tool to call, so say what it is
*for* and what it needs first — "Search Notion for pages by title. Use this first when you know a
page by name but not by id; nearly every other Notion tool needs an id."

### `auth` — one shape, every scheme

```yaml
auth:
  token_env: ACME_TOKEN     # required
  header: Authorization     # default
  format: "Bearer {token}"  # default
  in: header                # default; the other value is `base_url`
```

`X-Api-Key: {token}` and `Authorization: token {token}` are the same block with different values.
The credential is leased per call from the secrets store and never appears in the manifest.

A few providers put the credential in the URL instead of a header — Telegram's Bot API is
`/bot<token>/sendMessage`. Set `in: base_url` and template the path:

```yaml
base_url: https://api.telegram.org/bot{token}
auth:
  token_env: TELEGRAM_BOT_TOKEN
  in: base_url
```

`{token}` may only appear in the **path**; the host stays literal, so the destination allow-list
still pins one origin. The credential is substituted verbatim rather than percent-encoded —
encoding Telegram's `123:ABC` into `123%3AABC` would produce a URL the provider 404s — so a
credential that is not already a clean path segment is **rejected** rather than silently mangled.
Declaring `in: base_url` with no `{token}`, or leaving a `{token}` in a header-placed base URL,
both fail at compile.

### Per-install path segments — `{VAR}` in `base_url`

Some providers put an install-specific id in the URL. Atlassian is the common case: every Confluence
call goes to `/ex/confluence/<cloud id>/...`, and that id differs per site. Reference any **non-secret**
connection variable by name and it is substituted at compile time:

```yaml
base_url: https://api.atlassian.com/ex/confluence/{CONFLUENCE_CLOUD_ID}/wiki/api/v2
```

The variable must be one the connect flow actually collects — a placeholder the operator was never
asked for fails at compile, not after they have connected. Two rules keep this from becoming a hole:

- **Secrets are refused.** Spelling the credential's own env var here (`{ACME_TOKEN}`) throws. Every
  other `{VAR}` is resolved at compile and the result is stored and logged, so a secret would be
  baked into an artifact meant to be inspectable. Only `{token}` is resolved late, per dispatch.
- **Values are validated, not encoded** — same rule as `{token}`: a value containing `/ ? # %` is
  rejected rather than escaped, so it cannot add a path segment or smuggle an encoded character.

The **host is still literal**. Per-install *hosts* — self-hosted GitLab, `<site>.atlassian.net`,
Jira Server — remain unsupported on purpose, because the destination allow-list is what stops the
host making authenticated calls to an origin chosen at runtime. Supporting them is a real design
decision, not a missing feature.

### `mutating` — approval gating

Any method other than `GET` is treated as mutating, and mutating Tools are approval-gated. Override
it when a provider models a read as a `POST` — Notion's `search` and `queryDatabase` both do, and
without `mutating: false` a plain listing would ask the operator for approval.

### What the compiler does to a spec

- **`$ref`s are resolved at compile time.** A surviving pointer throws inside `ajv.compile` at
  registration and would take down *other* integrations' Tools, not just yours.
- **Remote `$ref`s are never fetched** — they collapse to a permissive schema. Fetching one would
  have the host request a URL your spec chose.
- **Request bodies nest under `body`.** A body property and a path parameter can share a name
  (Notion's `page_id` is both); merging them would silently drop one.
- **Path parameters are always required**, even when the spec omits the flag — a placeholder with
  no value cannot produce a URL.
- **A missing response schema is not fatal.** It falls back to a permissive object rather than
  refusing to compile: a provider's documentation quality should not decide whether an operator may
  use it.
- **`cookie` parameters are dropped**, not guessed at.

### `base_url` must be https with a literal host

Checked at install (`packages/soul/src/integration-trust.ts`) and again at compile. Templating in the
**path** is fine (above); a templated or plaintext **host** is rejected.

## Auth — how an operator connects

Five step kinds, composable in order. Each is a screen in the connect flow.

| Kind | Use when | Yields |
|---|---|---|
| `fields` | The provider issues a token from its own UI | Values the operator pastes |
| `oauth2` | The provider has a standard OAuth flow | A token, plus anything in `map` |
| `app_manifest` | The provider can create its app from a definition | Whatever `exchange` returns |
| `install` | Creating an app grants no access; installing it does | Whatever `capture` names |
| `webhook` | The provider delivers nothing until told where to | A generated delivery secret, plus anything in `map` |

Pick the *fewest* steps that work. Notion uses one `fields` step; GitHub needs `app_manifest` then
`install` because creating a GitHub App grants access to nothing.

Prefer an internal/personal token over OAuth when the provider offers one and the deployment serves
a single workspace — OAuth usually means submitting an app for the provider's review, which is real
friction for a self-hosted install.

Every step's `steps:` list is shown to the operator verbatim. Write them as instructions someone
can follow without already knowing the provider's UI.

### `webhook` — registering the delivery URL

A webhook channel receives nothing until the provider is told where to deliver. Asking an operator
to run `curl` is exactly the manual work this framework exists to remove, so declare it instead:

```yaml
- kind: webhook
  title: Point Telegram at this deployment
  url: https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/setWebhook
  secret_env: TELEGRAM_WEBHOOK_SECRET
  body:
    url: "{webhook_url}"
    secret_token: "{TELEGRAM_WEBHOOK_SECRET}"
    allowed_updates: [message]
```

- `{webhook_url}` is this deployment's ingress URL, supplied by the host. Every other `{name}` is a
  connection env var, and the validator proves at load that each is actually produced by an earlier
  step — a placeholder nothing fills would otherwise register a URL containing the literal text
  `{TELEGRAM_BOT_TOKEN}`.
- `secret_env` generates a 32-byte secret and stores it under that name. Generated rather than
  pasted so it is high-entropy and never transits a clipboard. It **must** match
  `ingress.webhook.security.secret_env`, which is cross-checked at load: registering under one name
  while verifying another produces deliveries that fail forever and look like the provider's fault.
- String values in `body` are templated; arrays and booleans pass through.
- **Nothing is stored if registration fails** — non-2xx, or a body saying `{"ok": false}`. A stored
  secret with no registration behind it leaves an integration looking connected while every
  delivery bounces.

## Ingress — turning provider deliveries into conversations

A channel is an integration that also *receives*. Add an `ingress` block and the same manifest
yields a bot that holds conversations, replying with the very Tools its `egress` block publishes.
[`integrations/telegram/`](../../integrations/telegram/) is the reference.

```yaml
ingress:
  handler: ingress.ts
  webhook:
    security:
      type: shared_secret
      header: X-Telegram-Bot-Api-Secret-Token
      secret_env: TELEGRAM_WEBHOOK_SECRET
    dedup_key: update_id
  context_env: [TELEGRAM_BOT_USERNAME]
  chat:
    thread_key: "{message.chat.id}/{message.message_thread_id|message.message_id}"
    reply:
      default:
        tool: send_message
        args:
          body: { chat_id: "{chat}", text: "{text}" }
```

### `security` — proving the delivery came from the provider

| Type | Provider does | Fields |
|---|---|---|
| `hmac_sha256` | Signs the raw body with a shared secret (GitHub, Stripe) | `header`, `secret_env`, optional `prefix` |
| `shared_secret` | Echoes back a secret you registered (Telegram) | `header`, `secret_env` |

Both are compared in constant time, and an **empty** header never matches an empty secret — a
misconfigured integration must reject traffic, not accept all of it. Route code calls one
`verifyWebhookRequest`, so adding a scheme cannot become a missed branch that lets unsigned traffic
through.

Set `dedup_key` (a body dot-path) or `dedup_header` so a provider's retry collapses into the
delivery it repeats instead of answering the same message twice.

### `handler` — the classifier

The one piece of a channel that is code, because "is this addressed to me?" is judgement, not
configuration. It runs in an isolated-vm sandbox as a pure function: no network, no filesystem, no
timers. It is authored as an object-literal expression and returns one decision per delivery —
`chat`, `event`, or `ignore`.

Its context is deliberately small: `ctx.body`, `ctx.headers`, `ctx.hasThreadMapping` (computed by
the host from `thread_key`, because the isolate cannot look anything up), and `ctx.env`.

`ctx.env` is exactly what `context_env` names, and nothing else. A Telegram update never says which
bot it was sent to, so a classifier cannot recognise a mention of itself without being told its own
`@username`. **Naming a var the auth flow stores as a secret is rejected at load** — a classifier is
untrusted per-integration code, and a credential handed to it is a credential exfiltrated by its
next version.

Because a handler is code, only integrations bundled in this repo may declare one; a third-party
manifest with an `ingress` block is refused at install.

### `chat` — where a reply goes

`thread_key` is a body dot-path template (`|` separates fallbacks) that names the external
conversation. Get its axes right or distinct conversations merge: Telegram needs
`message_thread_id` for forum topics, because without it every topic in a forum collapses into one
conversation.

`reply` is a map of named bindings; the classifier's decision picks one by name. A binding calls
this integration's own compiled Tools by their manifest `name`, so `send_message` here is the
`send_message` operation above — the two halves are one manifest.

Binding `args` are templated through the whole tree: strings take `{var}` substitutions, and
objects, arrays, booleans and numbers pass through as declared. Nesting matters — an `openapi` Tool
takes its request body under `body`, so a flat binding could not call one at all.

`identity` resolves a sender to a TulipFarm user via `email_path`. Providers that never expose an
email (Telegram is one) simply leave senders unlinked until they bind an account, which is a
documented path with an offered link rather than a failure.

## What third-party integrations may not do

Enforced at install by `packages/soul/src/integration-trust.ts`, before any file lands:

| Rejected | Because |
|---|---|
| `egress.type: ts-code` | It is code, and installing an integration must not mean running code |
| `egress.entry.transport: stdio` | Same — it launches a process on the host |
| `ingress.handler` | Same — a classifier is a sandboxed module, but still a module |
| a non-https or templated `base_url` | The host would make an authenticated call to a host you chose at runtime |

Bundled integrations in this repo may use `ts-code` (Slack and GitHub do, for transport work the
declarative layer does not yet cover), but a new integration should not: anything expressible as
`openapi` egress should be.

## Checklist

1. `mkdir integrations/<slug>` — the directory name is the install slug and the Tool prefix.
2. Write `manifest.yml`: identity, `auth`, `egress`.
3. Add the OpenAPI document if `egress.type: openapi`. Trim it to what you publish; it is parsed
   and compiled on every boot.
4. Write `setup-guide.md` — especially any step the provider requires that a token alone does not
   cover. Notion's per-page sharing is the canonical example: a valid token with nothing shared
   looks exactly like a broken integration.
5. Add an entry to [`integrations/registry.yml`](../../integrations/registry.yml) for the catalog
   title, category, and brand `icon` (a [Simple Icons](https://simpleicons.org) slug).
6. Write a test that compiles the real shipped files, in the shape of
   `apps/api/src/tools/declarative/notion.test.ts`. A fixture would keep passing after the real
   manifest broke.

For a channel, also:

7. Write `ingress.ts`, and vendor a byte-identical copy as
   `apps/api/src/ingress/__fixtures__/<slug>-ingress.hook.txt`. Assert its full decision matrix
   through the **real** sandbox — see `apps/api/src/ingress/telegram-parity.fixture.test.ts`.
8. Assert that every `reply` and `identity` binding names a Tool the manifest actually publishes,
   *and* that its rendered args satisfy that Tool's own input schema. Both halves fail silently
   otherwise: nothing breaks until a real person sends a real message and gets silence back.

## Where this runs

| Piece | Lives in |
|---|---|
| Authoring contract (`EgressConfig`, `EgressOperation`, `EgressAuth`, `IngressConfig`, `AuthStep`) | `packages/soul/src/types.ts` |
| Install-time trust policy | `packages/soul/src/integration-trust.ts` |
| Spec → Tool contract compiler | `packages/integrations/src/egress/openapi-compile.ts` |
| Per-operation HTTP adapter | `packages/integrations/src/egress/openapi-adapter.ts` |
| Governed Tool composition | `apps/api/src/tools/declarative/tools.ts` |
| Connect/disconnect registry reconciliation | `apps/api/src/tools/declarative/sync.ts` |
| Connect-flow step execution (incl. webhook registration) | `apps/api/src/integrations/auth-broker.ts` |
| Delivery verification | `apps/api/src/ingress/signature.ts` |
| Classifier sandbox | `packages/sandbox/src/hooks/` |
| Reply/identity binding execution | `apps/api/src/ingress/bindings.ts` |

Manifest Tools take the same governed path as the hand-written ones — `EffectStore.reserve` then
`EffectDispatcher.dispatch` — so a declarative mutation is as replay-safe and auditable as a
bespoke one. Declarative authorship changes *who writes* an integration, not how far the platform
trusts it.
