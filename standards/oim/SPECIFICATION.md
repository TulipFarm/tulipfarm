# Open Integration Manifest 1.0

## Status and language

Open Integration Manifest (OIM) is a vendor-neutral package format for declarative third-party
Integrations. This text defines OIM specification version 1.0 and the Core 1.0, Core 1.1,
Core 1.2, Auth 1.0, Events 1.0, Knowledge 1.0, Knowledge 1.1, Knowledge 1.2, and
Hooks 1.0 profiles.

The key words MUST, MUST NOT, REQUIRED, SHOULD, SHOULD NOT, and MAY are normative.

## Package

An OIM package MUST be a directory whose only entry point is `oim.yml`. A runtime MUST NOT treat
`manifest.yml` or another filename as the OIM entry point.

`oim.yml` MUST:

- set `oimVersion` to `"1.0"` and `kind` to `Integration`;
- declare a semantic package version and at least one operation;
- claim exactly one Core profile version;
- claim every optional profile whose section it uses;
- list every companion file by path, role, and lowercase SHA-256 digest.

Allowed companion roles are `openapi`, `graphql`, `guide`, `hook`, and `fixture`. Files not declared
in `oim.yml` MUST be rejected. Missing files and digest mismatches MUST be rejected. Symbolic links,
hidden files, archives, binaries, dependency manifests, lockfiles, native modules, WebAssembly,
and install scripts MUST be rejected.

OIM packages MUST NOT install provider SDKs or arbitrary dependencies. Runtime persistence,
authorization, approval, and Secret storage are host concerns, not portable package behavior.

## Core profiles

All Core versions define strict package shape, native HTTP operations, allowlisted OpenAPI
operations, fixed GraphQL documents, effect classes, identity modes, request and response JSON
Schemas, pagination, rate-limit hints, stable operation identity, exact package contents, offline
fixtures, and same-major compatibility.

Core 1.1 adds path credential injection, a secondary credential, explicit HTTP content type,
constant and Connection-configuration HTTP parameters, configuration placeholders in paths,
Connection-configured GraphQL hosts, and body cursor pagination. Configuration-bound values MUST
come from declared non-secret fields with compatible scalar types and MUST NOT remain Agent input.
A GraphQL URL placeholder MUST occupy the complete host and resolve within `allowedOriginHosts`.

Core 1.2 adds multipart HTTP requests and binary responses represented by host-managed File ids.

A package claiming an older Core version MUST NOT use a feature added by a later version. A runtime
claiming Core 1.2 MUST also accept valid Core 1.0 and Core 1.1 packages.

## Auth 1.0

Auth declares credential slots, non-secret configuration fields, and ordered connection steps.
Password inputs MUST target credential slots. Secret values MUST NOT enter the manifest, model
context, logs, fixture files, or conformance reports. OAuth authorization URLs and token URLs MUST
use public HTTPS origins. Templated origins MUST be bounded by declared host patterns. An OAuth
step's token endpoint authentication method applies to both code exchange and refresh. Public
clients (`none`) MUST omit `clientSecret` and use PKCE. Secret methods MUST declare
`clientSecret`; omission defaults to `client_secret_post` when that Secret exists and `none`
otherwise.

## Events 1.0

Events declares a relative ingress path, a closed verification scheme, deduplication, optional
handshake and acceptance rules, and typed event contracts. A runtime MUST verify a delivery before
accepting it, make it durable before acknowledgement, deduplicate as declared, and validate the
normalized event against its declared JSON Schema.

## Knowledge 1.0

Knowledge maps Core read operations to source discovery, listing, content, access control,
identity, deletion, and optional live authorization roles. A runtime MUST preserve source access
controls and deletion semantics. The profile does not create a second network mechanism.

## Knowledge 1.1

Knowledge 1.1 adds host-projected item fields, ordered item identity, operation-parameter bindings,
joined scalar content, principal-set live authorization, and the RFC 6901 root pointer. Parameter
bindings MUST resolve only from declared projected item fields. A package using these constructs
MUST claim Knowledge 1.1; Knowledge 1.0 packages remain valid without them.

## Knowledge 1.2

Knowledge 1.2 adds `liveAuthorization.principalBody` for providers whose authoritative access
check requires a nested JSON body. `template` MUST be a fixed JSON object and `pointer` MUST name
an absent object property using RFC 6901. The runtime MUST deep-clone the template, reject array
traversal and the segments `__proto__`, `constructor`, and `prototype`, and insert only the
provider identity proven for the requesting principal. Ordinary configuration, an Agent, and Tool
input MUST NOT supply or replace that identity. The completed body MUST pass the operation's
`requestSchema` before dispatch.

The operation MUST be an HTTP JSON operation and `principalParameter` MUST be `body`. Provider
failure, an invalid body, a missing identity proof, an invalid or non-Boolean `allowedPointer`
result, or `false` MUST deny access. A runtime MUST NOT advertise Knowledge 1.2 unless it implements
this binding and fail-closed decision behavior; Knowledge 1.0 and 1.1 declarations are not silently
reinterpreted.

## Hooks 1.0

Hooks are bounded pure functions for input validation, request shaping, response normalization,
webhook classification, content mapping, and access-control mapping. Hooks MUST have no network,
filesystem, process, timer, random, storage, or Secret capability. A host MAY apply a stricter
trust policy and refuse hooks.

## Schemas and semantic validation

The JSON Schemas in `schemas/` define structural contracts. Cross-field, package-content,
embedded-schema, public-origin, profile-version, OpenAPI, GraphQL, and compatibility rules require
the semantic validator. Passing a JSON Schema alone is not full package validation.

The profile schemas are derived views of the authoritative manifest schema. Core profile schemas
pin the declared Core version; the semantic validator enforces feature gates.

## Conformance

A runtime MUST claim only profiles it has executed through every required conformance case.
Syntax validation does not prove operation execution, OAuth handling, durable event delivery,
access-control preservation, or hook isolation.

The runner in this distribution sends portable behavior vectors to a runtime adapter. The adapter
MUST exercise the runtime's public interface. A skipped, failed, missing, or mismatched vector
prevents a claim. Claims identify the runtime, exact profile versions, and passed case ids.

A capability advertisement MUST be built from a successful conformance report. It states the
exact OIM specification versions, package entry point, supported profile versions, suite version,
suite digest, and passed cases.

## Compatibility and extensions

Patch and minor package releases MUST NOT remove or rename operations, make accepted input
stricter, change effect or identity mode, remove stable output, narrow projection, or reduce a
response bound. Breaking changes require a new package major version.

Portable extensions MUST use an `x-` namespace. Vendor-specific behavior MUST remain namespaced
and MUST NOT change the meaning of portable fields.

## Distribution

This specification and its original conformance material are licensed under Apache-2.0. Generated
implementation code retains the notices listed in `NOTICE`.

This distribution does not create an official registry, repository, npm release, signing
authority, support promise, or trademark grant. Those actions require authorization outside this
specification.
