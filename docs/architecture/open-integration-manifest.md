# Open Integration Manifest

Status: **Foundation implemented; runtime profile adoption is incremental**

The Open Integration Manifest (OIM) is the portable contract for describing an Integration without
installing provider SDKs or launching package-supplied processes. TulipFarm is the first reference
implementation. The standard is vendor-neutral; TulipFarm-specific data belongs under the
`x-tulipfarm` extension namespace.

OIM is intended for publication under Apache-2.0 in a neutral specification repository. The
implementation in this repository remains covered by the repository license.

## Package boundary

An OIM package has one `manifest.yml` entry point and an exact set of declared companion files.
Every companion carries a lowercase SHA-256 digest in the manifest.

Allowed companion roles are:

| Role | Content |
| --- | --- |
| `openapi` | OpenAPI JSON or YAML |
| `graphql` | Fixed GraphQL documents |
| `guide` | Markdown setup or usage guidance |
| `hook` | Pure JavaScript hooks |
| `fixture` | Redacted JSON, YAML, or text fixtures |

Dependency manifests, lockfiles, install scripts, archives, binaries, native modules, and WebAssembly
are rejected. Package validation also rejects undeclared, missing, or digest-mismatched files.

### Offline fixtures

A `fixture` companion is an offline test suite for the package. TulipFarm runs every declared suite
during inspect, install, and update, and an authenticated person can run an installed package's
fixtures again at `POST /api/v1/integrations/:name/fixtures`. A failing case rejects the package
before it is trusted.

```yaml
version: 1
cases:
  - name: gets-current-weather
    operationId: current-weather
    request:
      q: London
      units: metric
    response:
      status: 200
      body: { name: London, main: { temp: 18 } }
    expect:
      request:
        method: GET
        url: https://api.weather.example/current?q=London&units=metric
      result:
        name: London
        main: { temp: 18 }
```

`request` is sent through the package's ordinary compiler and adapter. The fixture transport only
returns `response`; it never opens a socket. `expect.request` and `expect.result` are asserted as
partial object matches. Fixture files cannot declare credentials, a clock, or network access.
Credential-bearing operations receive a fixed inert test token from the host, never a stored
Secret.

## Profiles

Profile versions are independent of the package version:

| Profile | Owns |
| --- | --- |
| `core` | Package shape, native HTTP, OpenAPI, GraphQL, operation contracts |
| `auth` | Connection setup and credential acquisition |
| `events` | Verified durable webhook deliveries and typed Integration events |
| `knowledge` | Operation roles for ACL-preserving Knowledge ingestion |
| `hooks` | Bounded pure JavaScript transformations |

Every package claims `core`. Optional profile claims are explicit. A runtime publishes a
conformance claim containing its supported profile versions and the standard cases it passed.

## Auth and Connections

The Auth profile declares credential slots, safe configuration fields, and ordered setup steps.
Setup may collect fields, run OAuth 2.0, create a provider app manifest, complete an installation,
or register a webhook. Provider URLs must use public HTTPS origins.

A Connection binds one Integration major version to an owner scope. Personal Connections belong to
one user. Organization Connections are shared only through explicit authorization. Team Connections
belong to one Team: Team members with effective Team access may use them, while only exact-Team
administrators may create, authorize, test, or revoke them. Multiple named Connections may exist
for the same Integration, with at most one active default per owner scope and owner.

Connection configuration and sealed credentials are separate. Only fields declared
`agentVisible` may enter model Context. Credential slots hold opaque `secret://` references; the
plaintext exists only inside a short-lived Secret Broker callback. Rotation replaces the stored
value and revokes every outstanding lease for that Secret immediately. Revoking a Connection
revokes all leases issued through it.

Connection selection is fail-closed. An explicit Connection ID must still pass live authorization
and must match the operation's identity mode. Without an explicit choice, `personal_required`
considers only the acting user's Connections, `shared_only` considers only authorized Team and
organization Connections, and `shared_or_personal` prefers a personal default, then a Team
default, before an organization default.
Missing or ambiguous defaults return safe candidate metadata for a trusted choice surface; Secret
bindings and non-agent-visible configuration are never included.

OAuth Connections refresh on a five-minute schedule once their recorded expiry is within ten
minutes. The Connection is `expiring` while renewal runs, returns to `healthy` after the new access
token, rotated refresh token, and expiry are stored, and becomes `action_required` if renewal
fails. A failed renewal never revokes the Connection; the person can re-authorize it. Tool answers
name whether the next action is to connect, choose a Connection, or reconnect one.

An auth `webhook` step names native HTTP operations to create and remove one provider subscription.
It declares where the host supplies the OIM ingress URL and delivery Secret, and where the create
response carries the provider subscription id. On connect, TulipFarm mints the delivery Secret,
registers `/api/v1/hooks/oim/:slug`, and stores the opaque Secret reference and subscription state
on the Connection. Revoke removes the provider subscription before deleting Secrets. A removal
failure leaves the Connection active and `action_required`. When the public API origin changes,
TulipFarm registers a replacement with a new delivery Secret before attempting removal of the old
subscription, so a delivery signed with the old Secret no longer verifies.

An Integration may instead declare `ingress.kind: polling`. It names one read-only native HTTP
operation, a cursor response pointer and request parameter, and an interval floor of at least 60
seconds. The API runtime owns this scheduler because it owns the live Soul and the credential
broker. It leases one Connection before calling the operation, uses leased credentials, emits the
same typed Integration events as webhook ingress, and advances the opaque cursor only after
dispatch. A Connection with a registered webhook is excluded: webhook delivery is preferred and
polling is its fallback, never a duplicate default.

## Core operations

Every operation has:

- a stable operation id and a model-facing Tool name;
- an effect class and credential identity mode;
- a native HTTP, allowlisted OpenAPI, or fixed GraphQL source;
- optional request JSON Schema;
- response JSON Schema, projection, and byte limit, or a binary response stored as a File;
- optional pagination and rate-limit declarations.

Core 1.2 supports a native HTTP `multipart` body with at most 16 declared parts. A `file` part
names a File id in the request schema. The host authorizes that File and streams its bytes; bytes
never enter Tool arguments, effect records, or Tool results. Regular parts carry an explicit byte
limit. A binary response is stored through the same Files service that checks uploads. Its Tool
result contains the File id and bounded provenance metadata, never response bytes.

The stable runtime Tool id is derived from the package id, package major version, and operation id.
Friendly aliases are presentation only. Persisted Agents and Routines keep the stable id so
side-by-side major versions cannot silently reroute work.

## Compatibility

Patch and minor releases remain within one package major version. They may add operations, optional
request properties, and response properties. They may not remove an operation, rename its Tool,
change its effect or identity mode, add a required input, remove a stable response field, narrow a
declared response projection, or reduce the response bound.

Breaking changes use a new major version. Installation and migration policy belongs to the host
runtime; OIM only defines the compatibility evidence.

## Hooks

Hooks are pure functions for input validation, request shaping, response normalization, webhook
classification, and content or ACL mapping. The portable contract grants no network, filesystem,
storage, process, clock, randomness, or Secret access.

OIM defines the hook interface. A host may impose a stricter trust policy. TulipFarm permits hooks
only in TulipFarm-verified signed releases; unsupported Community packages remain declarative.

## Ownership

- `@tulipfarm/schema` owns the portable schema, package integrity rules, compatibility checks, and
  conformance claim vocabulary.
- `@tulipfarm/integrations` will own compilation and provider-neutral execution.
- `@tulipfarm/storage` persists scoped Connection metadata and opaque Secret bindings.
- `@tulipfarm/secrets` owns Connection-bound leases, rotation, revocation, and plaintext containment.
- `@tulipfarm/authz`, `@tulipfarm/tool-broker`, `@tulipfarm/knowledge`, and the Run kernel retain
  their existing accountable boundaries.
- Current `integrations/*/manifest.yml` files use the legacy TulipFarm contract until explicit
  adapters and profile runtimes land. OIM does not create a flag-day migration.

## Evidence

The schema package carries:

- strict TypeBox schemas and derived TypeScript types;
- structural and cross-field validation;
- exact package-content and digest validation;
- conservative same-major compatibility checks;
- versioned conformance case identifiers;
- positive and negative manifest and runtime-claim fixtures.

Later profile work extends this same contract rather than creating parallel manifest formats.
