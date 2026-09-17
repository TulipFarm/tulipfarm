# Building an Integration

TulipFarm integrations use the Open Integration Manifest (OIM). An OIM package is declarative:
`oim.yml` plus only the companion contracts, guides, and offline fixtures that the manifest names
by digest. It contains no provider SDK, hook, install script, or generated executable code.

Users build and publish integrations through chat with `integration-forge`. This page is the
contributor reference for bundled packages under [`integrations/`](../../integrations/). The
portable contract is [`standards/oim/SPECIFICATION.md`](../../standards/oim/SPECIFICATION.md).

## Package shape

```text
integrations/acme/
├── oim.yml
├── setup-guide.md
├── fixtures.yml
├── acme-openapi.yml
└── operations/
    └── list-items.graphql
```

Only declared companions belong in the package. Each entry in `files` has a role and the SHA-256
of its exact bytes. Package loading rejects missing, changed, duplicate, and undeclared files.

The manifest starts with:

```yaml
oimVersion: "1.0"
kind: Integration

metadata:
  id: acme
  name: Acme
  version: 1.0.0
  description: Read and update selected Acme records.
  license: Apache-2.0
  maintainers:
    - name: Muskan Vijayvargiya
      url: https://example.com

profiles:
  core: "1.2"
  auth: "1.1"
```

Use the lowest profile version that supports the package. A block requires its matching profile:
`auth`, `events`, and `knowledge` are not inferred.

## Authentication and verification

Authentication declares credential slots, non-secret configuration, and ordered setup steps.
Credential values are supplied later through a connection and stored as secrets. They never belong
in `oim.yml`, a companion, a fixture, or a tool argument.

Credential ownership follows **producers**, not consumers: a fields step produces its declared
targets; OAuth and JWT steps produce their response bindings, but consume their client or signing
credentials. A required configuration field must have a fields or callback binding that produces
it. Declaring a configuration field alone does not make it collectable.

To correct saved input, the Connection API supports
`PATCH /api/v1/integrations/:key/connections/:connectionId/credentials` with
`{ "values": { "<field-id>": "<replacement>" } }`. Only declared fields-step IDs are accepted;
omitted fields remain unchanged. The response contains only `connectionId` and `verification`,
never stored credentials. The authorization gate is the same as starting provider authorization.
Replacement preserves the Connection's owner and references, fences stale callbacks and refreshes,
and invalidates earlier verification evidence. Changed fields require fresh browser authorization
because consent can depend on configuration embedded in provider URLs and callback bindings.
Static credentials are immediately reverified. Failed proof persists `action_required` and retires
the previous healthy evidence; retry verifies the saved values, while another PATCH corrects them.

New connectable packages use Auth 1.1 and provider verification:

```yaml
auth:
  credentialSlots:
    - id: api_token
      label: Acme API token
      kind: api_key
      required: true
  steps:
    - id: token
      type: fields
      title: Enter your Acme API token
      fields:
        - id: api_token
          label: API token
          input: password
          required: true
          target: { type: credential, slot: api_token }
  verification:
    issuer:
      source: package
      value: https://api.acme.com
    checks:
      - id: current-user
        operationId: acme-whoami
        credentialSlots: [api_token]
        success:
          - kind: present
            path: /id
    evidence:
      assurance: identified
      subject:
        kind: human
        checkId: current-user
        path: /id
        namespace: issuer
```

A verification check is a fixed native HTTP `GET` or a digest-pinned GraphQL `query`, with read
effect and no required agent input. The catalog carries the fixed GraphQL companion bytes into
the verifier; it checks their declared digest and the package digest before compiling. Mutations
and subscriptions cannot verify credentials. GraphQL body errors reject even partial HTTP 200
responses; no provider-specific host is needed. Identified evidence
requires a real, nonempty provider subject. Use `validity_only` when a provider can prove only that
a credential works; do not invent identity from configuration or a browser callback.

The issuer is bound to a package-owned HTTPS origin or to required configuration whose origin the
manifest constrains. A tenant or selected account must be read from a successful check or compared
with a trusted configured value. The host binds evidence to the exact connection, package digest,
configuration digest, auth-step revisions, and credential references.

## Operations

Each operation is one callable agent tool:

```yaml
operations:
  - id: acme-search
    name: acme_search
    description: Search Acme records by title.
    effect: read
    identityMode: shared_or_personal
    credentialSlot: api_token
    credentialInjection:
      in: header
      name: Authorization
      format: "Bearer {token}"
    source:
      type: http
      method: GET
      baseUrl: https://api.acme.com
      path: /v1/search
      parameters:
        - name: q
          in: query
          required: true
          schema: { type: string }
    response:
      maxBytes: 65536
      schema:
        type: object
        properties:
          results: { type: array }
      projection: [/results]
```

The operation owns:

- one fixed public HTTPS destination;
- one honest effect: `read`, `sensitive_read`, `create`, `update`, `delete`, `send`, or `admin`;
- one identity mode;
- a closed request contract;
- a bounded response and the fields exposed to the model;
- optional rate and pagination limits.

An operation may instead name one digest-covered OpenAPI operation or one fixed GraphQL document.
Never expose a generic URL, OpenAPI operation id, GraphQL document, or query string to the model.

File inputs carry a TulipFarm File id. The host checks ownership and streams the stored bytes to the
declared destination. Binary responses are written through the File host; they are not embedded in
model output.

## Events and knowledge

An `events` block declares webhook or polling ingress, provider authentication, normalization, and
delivery semantics. An authored package cannot add executable handlers.

A `knowledge` block declares provider objects that can be synchronized into knowledge. The adapter
must preserve provider ACLs, ownership, source locators, and fenced checkpoints. A package removal
tombstones or quarantines its published content before durable cleanup completes.

Use the bundled packages as examples, but validate against the current profile schemas rather than
copying an older package.

## Setup guide and fixtures

For an HTTP operation that succeeds without a body, declare
`response.schema: { type: "null" }`. The HTTP adapter maps a bodyless **204 only** to JSON `null`
before normal schema validation. This is an explicit output contract, not a fallback for failed
validation: an empty 200, an object where null is required, and a 204 under an object schema still
fail. Keep the response byte bound. In offline fixtures, use `response: { status: 204, body: null }`
and `expect.result: null`; YAML null represents absent wire content, not an impossible `{}` body.

`setup-guide.md` explains provider-side setup, credential creation, actor and tenant distinctions,
and the connection steps shown by TulipFarm. It must not contain a live credential.

`fixtures.yml` records deterministic provider responses and checks the exact outbound request and
normalized result. Cover every authored operation, a provider refusal, and any File path. Fixtures
have no network, filesystem, clock, or real credential access.

## Validate

From the repository root:

```bash
pnpm exec oim validate ./integrations/acme
```

## Live provider smoke tests

The OIM live provider smoke suite verifies the production HTTP adapter against a real provider
connection, then performs one bounded read-only operation. It is opt-in: normal local tests and CI
make no provider request, even if a credential happens to be in the environment.

Set `OIM_LIVE_PROVIDER_SMOKE=1` and only the credentials for the provider you want to check. The
suite does not print credential values or provider responses.

```bash
# OpenWeather: verifies the API key, then reads current weather for London, GB.
OIM_LIVE_PROVIDER_SMOKE=1 \
OIM_LIVE_OPENWEATHER_API_KEY=... \
pnpm test:oim-live-providers

# Trello: verifies the connected member, then lists accessible open boards.
OIM_LIVE_PROVIDER_SMOKE=1 \
OIM_LIVE_TRELLO_API_KEY=... \
OIM_LIVE_TRELLO_TOKEN=... \
pnpm test:oim-live-providers

# GitLab.com: reads the token owner, which is its authentication check.
OIM_LIVE_PROVIDER_SMOKE=1 \
OIM_LIVE_GITLAB_ACCESS_TOKEN=... \
pnpm test:oim-live-providers
```

The supported provider credentials are:

| Provider | Required environment variables |
| --- | --- |
| OpenWeather | `OIM_LIVE_OPENWEATHER_API_KEY` |
| Trello | `OIM_LIVE_TRELLO_API_KEY`, `OIM_LIVE_TRELLO_TOKEN` |
| GitLab.com | `OIM_LIVE_GITLAB_ACCESS_TOKEN` |

Leave the opt-in variable unset for ordinary development and CI. Store values in your shell or
secret manager, not in tracked files. The GitLab smoke check intentionally targets `gitlab.com`;
self-managed origins need their normal explicit Connection approval.

For a release:

1. Run package validation and every offline fixture through the production runtime adapter.
2. Compare the new package with the prior published version.
3. Keep a patch or minor release only when compatibility checks pass; otherwise increment the
   major version.
4. Recompute every changed companion digest and the complete package digest.
5. Update the trusted release registry with the exact version and package digest.

The runtime accepts an official package only after signature and trust verification. A community
package is bound to the exact digest a user reviewed and approved.

## Product path

Do not ask users to edit the soul or an integration directory.

```text
Chat request
  -> integration-forge reads public provider documentation
  -> integration_draft_review validates and runs fixtures
  -> user reviews destinations, credentials, and effects
  -> integration_draft_create publishes the exact reviewed digest
  -> Integrations screen collects and verifies credentials
  -> tools, ingress, and knowledge become reachable
```

Disconnect makes the connection unavailable immediately. Package removal waits for remote ingress
teardown and knowledge tombstone or quarantine work to finish, with durable retry, before removing
the package.
