# Authoring an OIM package

The shape of `oim.yml`, the rules that reject one, and a complete worked example. Read this while
writing step 3 of the forge; `integration_draft_review` reports anything you get wrong, but the
rules below are the ones that cost a round trip.

## Skeleton

```yaml
oimVersion: "1.0"
kind: Integration

metadata:
  id: acme # the slug, and the directory it lands in
  name: Acme
  version: 1.0.0 # semver; the major version binds Connections
  description: One sentence an operator reads before installing.
  license: Apache-2.0
  maintainers:
    - name: Your Name
      url: https://example.com

profiles:
  core: "1.2" # always; use the lowest version that supports the package's constructs
  auth: "1.0" # whenever there is an `auth:` block
  events: "1.0" # whenever there is an `events:` block
  knowledge: "1.0" # whenever there is a `knowledge:` block

auth:
  credentialSlots:
    - id: api_token # ^[a-z][a-z0-9_]{1,63}$ — API_TOKEN is rejected
      label: Acme API token
      kind: api_key # api_key | bearer_token | oauth2_access_token | oauth2_refresh_token |
      #       client_secret | private_key | webhook_secret
      required: true
  configurationFields:
    - id: workspace
      label: Workspace name
      type: string
      required: true
      agentVisible: false # true only when an Agent must pass it as an argument
  steps:
    - id: token # ^[a-z][a-z0-9_]{1,63}$
      type: fields # fields | oauth2 | app_manifest | install | webhook
      title: Enter your Acme API token
      description: Where to get it, in one or two sentences.
      fields:
        - id: api_token
          label: API token
          input: password
          required: true
          target: { type: credential, slot: api_token }
  healthCheckOperationId: acme-whoami # a cheap read that proves the credential works

operations:
  - id: acme-search # kebab-case
    name: acme_search # the Tool name an Agent calls: snake_case
    description: What it does, in the words a model needs to choose it.
    effect: read # read|sensitive_read|create|update|delete|send|admin
    identityMode: shared_only # shared_only | personal_required | shared_or_personal
    credentialSlot: api_token
    credentialInjection:
      in: header # header | query
      name: Authorization
      format: "Bearer {token}" # exactly one {token}
    source:
      type: http
      method: GET
      baseUrl: https://api.acme.com # one host; this is the whole promise
      path: /v1/search
      parameters:
        - name: q
          in: query # path | query | header
          required: true
          schema: { type: string }
    response:
      maxBytes: 65536
      schema:
        type: object
        properties:
          results:
            type: array
            items:
              type: object
              properties:
                id: { type: string }
                title: { type: string }
      projection: # exactly what an Agent sees; everything else is dropped
        - /results
    rateLimit:
      requests: 60
      perSeconds: 60
      scope: connection # connection | installation
```

## Rules that reject a manifest

- **Ids.** Credential slots, configuration fields and auth step ids all match
  `^[a-z][a-z0-9_]{1,63}$`. Operation ids are kebab-case; operation `name` is the snake_case Tool
  name and must be unique across the package.
- **Profiles follow blocks.** An `auth:` block without `profiles.auth` is refused, and so is every
  other block without its profile.
- **`credentialInjection.format` contains exactly one `{token}`.** Not `{{credential}}`, not two.
- **Hostnames must be public.** `localhost`, a private range, or a bare IP is refused; a package
  that could reach inside the deployment's network is not a third-party Integration.
- **No hooks, no companion files** from this forge. Both are refused before the review runs.
- **Every operation needs a `response.schema`.** Add a `projection` unless an Agent genuinely needs
  the whole body.

## Per-customer hosts

When the vendor gives each customer their own hostname (`acme.atlassian.net`,
`yourcompany.zendesk.com`), put one placeholder in the host and say what it may resolve to:

```yaml
auth:
  allowedOriginHosts:
    - "*.atlassian.net" # the promise; a wildcard never matches the bare parent
  configurationFields:
    - id: site
      label: Atlassian site
      type: url
      required: true

operations:
  - id: page-get
    # ...
    source:
      type: http
      method: GET
      baseUrl: https://{site}/wiki # exactly one placeholder, in the host only
      path: /api/v2/pages/{id}
```

The value is filled from the installation's configuration when the Tools compile, so the contract
pins the real host. A placeholder without `allowedOriginHosts` is refused.

## GraphQL providers

A provider with one endpoint and a query language is declared with a `graphql` source instead of
`http`. The operation does **not** carry query text — it names a document the package ships, so an
Agent can never compose its own query:

```yaml
files:
  - path: operations/list-teams.graphql
    role: graphql
    sha256: 9f2c… # of the file exactly as shipped

operations:
  - id: list-teams
    name: linear_list_teams
    effect: read
    source:
      type: graphql
      url: https://api.linear.app/graphql
      operation: ListTeams # must appear exactly once in the document
      documentFile: operations/list-teams.graphql
    requestSchema: # the whole object is the GraphQL variables
      type: object
      properties:
        first: { type: integer }
      required: [first]
      additionalProperties: false
```

Two rules bind these:

- The **document decides the effect**. A `read` whose document is a `mutation` is refused, because a
  write would otherwise pass an approval gate that only ever saw a read.
- `requestSchema` must be a closed object (`additionalProperties: false`), so an Agent cannot add a
  variable the document was never written against.

Pagination is HTTP query-parameter based, so a GraphQL package leaves `pagination` unset and exposes
the cursor as a variable instead.

### File uploads and downloads

Core 1.2 adds multipart request parts and binary responses. A File value is always its File id:
the runtime checks access, then streams the stored bytes directly to the provider. Do not put base64
or file content in the request schema.

```yaml
source:
  type: http
  method: POST
  baseUrl: https://api.acme.com
  path: /v1/files
  contentType: multipart
  multipart:
    parts:
      - name: metadata
        kind: field
        pointer: /metadata
        maxBytes: 65536
      - name: file
        kind: file
        pointer: /fileId
requestSchema:
  type: object
  properties:
    metadata: { type: object }
    fileId: { type: string }
  required: [metadata, fileId]
  additionalProperties: false
response:
  mode: binary
  maxBytes: 65536
```

`parts` has at most 16 entries. Each regular field declares its own byte limit. A file part is
validated only by the Files service's normal allowlist and magic-byte check; a package cannot
weaken or replace that check. A binary response is stored as a File and returns its id, filename,
media type, size, and whether it exceeded `maxBytes`. Provider bytes never enter Tool arguments or
Tool results.

## Basic authentication

`format` writes the header; `encoding` says what to do with the secret first:

```yaml
credentialInjection:
  in: header
  name: Authorization
  format: "Basic {token}"
  encoding: basic # base64 the credential before substituting it
```

Store the whole `user:password` pair in one credential slot and let `encoding: basic` encode it.
Splitting it across two slots does not work — an operation injects exactly one slot. `encoding`
defaults to `verbatim`, which is what a bearer token wants.

## Core 1.1 and 1.2 shapes

Five constructs cover the providers that Core 1.0 could not describe. Declaring any of them
requires `profiles.core: "1.1"`; a `"1.0"` package that uses one is refused **by name**, so the
error tells you which construct forced the bump.

### A credential in the path

Telegram addresses every endpoint as `/bot{token}/method`. Put the placeholder in `path`, never in
`baseUrl` — the host is what the Tool contract pins as its destination.

```yaml
credentialInjection:
  in: path
  format: "bot{token}" # exactly one {token}, as everywhere else
source:
  type: http
  method: GET
  baseUrl: https://api.telegram.org
  path: /{credential}/getMe # exactly one {credential}
```

The credential is substituted at dispatch, not at compile, so the compiled binding — which is
logged and inspected — never holds the secret. It is validated as a clean path segment rather than
percent-encoded, because Telegram's token contains a `:` its router will not accept as `%3A`.

### A pinned parameter

`value` fixes a parameter the Agent has no business setting: a required API version, a long-poll
timeout a bounded Tool call cannot honour, a filter the package guarantees.

```yaml
parameters:
  - name: Notion-Version
    in: header
    value: "2022-06-28"
    schema: { type: string }
```

A pinned parameter leaves the Tool's input schema entirely — an argument of the same name is
ignored, not honoured. Do not also set `required`; there is nothing for a caller to supply.

### A configuration field in the path

The same `{field}` placeholder `baseUrl` accepts also works in `path`, for a provider that puts the
account in the URL rather than the host:

```yaml
path: /2010-04-01/Accounts/{account_sid}/Messages.json
```

Declare `account_sid` under `auth.configurationFields`, and **never** also as a parameter: an Agent
able to set it could address an account the Connection was never authorized for. It is filled at
compile time, so the contract promises the URL the dispatch reaches.

### A form-encoded body

Twilio and several older REST APIs take `application/x-www-form-urlencoded`, not JSON.

```yaml
source:
  type: http
  method: POST
  contentType: form # json (the default) | form
requestSchema:
  type: object
  properties: # every property must be a scalar
    To: { type: string }
    Body: { type: string }
  required: [To, Body]
  additionalProperties: false
```

A nested property is refused at validation, not at call time: there is no portable form encoding
for one, and picking bracket notation or embedded JSON would be inventing a wire format the
provider's documentation never promised.

### A cursor in the request body

Some providers page by a cursor in the POST body rather than a query parameter.

```yaml
pagination:
  type: body_cursor
  requestPointer: /start_cursor # where the runtime writes it; never the whole body
  responsePath: /next_cursor # where the provider returns it
  itemsPath: /results
```

The operation must declare a `requestSchema` for the cursor to be written into, and must **not**
declare the cursor as a property — the Agent receives an opaque `page_token` and hands it straight
back. A provider that echoes an unchanged cursor stops the walk rather than looping.

## Identity

- `shared_only` — every Agent acts as one business account. The usual choice.
- `personal_required` — each person acts as themselves; the operation is unavailable until they
  connect their own Connection.
- `shared_or_personal` — prefers the person's own Connection and falls back to the business one.

If the provider reports who a token belongs to, map it under `identity.user` so Runs attribute
correctly. Map an email **only** if the provider also reports that it was verified; an unverified
address is a claim, not an identity, and the manifest is refused for treating it as one.

## Events

Declare `events:` only when the provider genuinely pushes webhooks. State how a delivery is
verified (`verification.scheme` plus the credential slot holding the signing secret), how a retry
is recognised (`deduplication`), and give each event type a body selector and a schema. TulipFarm
mints the receiving URL; the manifest never contains it.

An event type is selected by a JSON Pointer into the **body**, with `equals` or `matches`. A
provider that names the event only in a header cannot be typed by this profile. Headers a
normalization hook may read must be listed in `safeHeaders`; the signature header is withheld even
if listed.

## Shipped examples

Eight complete packages live in the repository and are validated on every run:

- `integrations/openweather/` — the simplest complete package: one organization API key, three read
  operations, projections, rate limits, a health check.
- `integrations/confluence/` — per-customer host, six read operations, per-item ACLs, identity
  links, and Knowledge indexing.
- `integrations/gitlab/` — writes as well as reads, `shared_or_personal` identity, and the events
  profile: `shared_secret` verification, four body-typed event types, header deduplication.
- `integrations/jira/` — a per-customer host plus Basic authentication, and a provider whose paging
  token lives in the response body, so it declares no `pagination` and lets the Agent page.
- `integrations/telegram/` — a credential in the path, and a pinned long-poll timeout.
- `integrations/twilio/` — a configuration field in the path, a form-encoded body, and Basic
  authentication over one `SID:secret` slot.
- `integrations/notion/` — a pinned API version header and a cursor the provider wants in the
  request body.
- `integrations/linear/` — the GraphQL profile: seven shipped, digest-pinned documents, closed
  variable schemas, and effects that match each document's operation kind.
