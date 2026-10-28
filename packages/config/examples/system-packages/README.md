# Portable system packages

The generated Draft 2020-12 schema is
[`../../schemas/system-package.v1.json`](../../schemas/system-package.v1.json).
The source contract is `packages/agents/src/system-package-contracts.ts`.

`leave-management.json`, `issue-tracking.json`, and `blog-writing.json` each
install linked tables, identified seed rows, a skill with two bundled files,
a read-only agent with an exact skill revision and table scope, and a saved
manual review workflow. Each resource has its own review. The agent is activated
only after review; the workflow is not enabled or invoked.
Bind `package-manager` to the importing person. Skill sharing replaces its
default grants, so each example explicitly retains that person's read, use and
manage permissions. A declared skill sharing policy without any manager fails
preflight; the installer never adds an undeclared grant.

`linked-records.json` adds mutually referencing table schemas, reverse fields,
sharing, a bundled base64 attachment, a file-valued seed row and a saved
row-triggered workflow. Cyclic schemas require separate reviews for empty
table shells and their final relationships; seed rows wait for final schemas.
This does not permit cyclic seed-row dependencies.

`sheet-event-review.json` shows a declared integration binding and provider
workflow. Replace its illustrative spreadsheet ID with the intended source
before validation. Bind an existing authorized integration with exactly that
source configuration. No token belongs in the package. Missing consent or a
different source is a preflight blocker, not a request to create a connection.

## Validation and generation

From the repository root:

```sh
pnpm --filter @tulipfarm/agents build
pnpm --filter @tulipfarm/agents generate:system-package-schema
pnpm --filter @tulipfarm/agents generate:system-package-examples
```

Generation validates the examples with the domain parsers and portable-reference
compiler. Its placeholder binding UUIDs are only used for offline compilation;
they are not written into the examples or treated as real workspace resources.

Structural schema validation is not semantic validation or authorization.
The semantic validator also checks uniqueness, reference kinds, dependencies,
field mappings, domain refinements, asset byte sizes and hashes. Runtime
preflight checks permissions, fixed-name conflicts, file-storage availability,
skill file safety and existing integration access.

## Installation API

The Packages page lists bundled local examples until the marketplace is connected.
Selecting Leave Management opens a real chat. Choose workspace inputs and click
Install there; opening the chat alone does not install anything. Reviews and
retries stay in chat. **Open installation** shows the preview or saved progress
with Sprout PlanOutline in the native canvas, with server verification last.
The canvas uses the same saved installation as the chat, including after reload.
Related steps appear in contiguous groups with counts from their actual states.
Grouping does not change execution or dependencies. Before access validation,
the outline shows file order and says that execution order is not yet checked;
after validation it uses the returned order. Final verification stays last.

All routes require the existing authenticated workspace session. Prefix these
paths with `/workspaces/:workspaceId`:

| Route                                                       | Body                                                                                                   |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `POST /system-packages/validate`                            | `{ "package": ..., "bindings": ... }`                                                                  |
| `POST /system-package-installations`                        | Above plus a stable `requestId` and optional `chatId`                                                  |
| `GET /system-package-installations?after=UUID&chatId=UUID`  | None; both filters are optional and chat access is checked                                             |
| `GET /system-package-installations/:installationId`         | None                                                                                                   |
| `POST /system-package-installations/:installationId/review` | `requestId`, `expectedVersion`, resource `key`, displayed `digest`, `decision` (`approve` or `reject`) |
| `POST /system-package-installations/:installationId/resume` | `expectedVersion`                                                                                      |

Bindings are keyed by the declared input key, for example:

```json
{
  "owning-team": { "kind": "team", "id": "THE-AUTHORIZED-TEAM-UUID" }
}
```

Keep each write's request ID across retries. A changed body with the same
identity is rejected. Importing the same release under a new request ID is a
separate installation, not an upgrade. Existing tables are never adopted by name.

The API sweep advances installations without an open browser. Table creation
and agent Soul publication use the existing Temporal workers, including the
storage worker. Local file storage must be configured for skills. Installation
and skill file review do not call a model.

Read the installation after review; it advances to the next review or waits
for a domain worker. Resume retries a blocked operation with its original
identities and inputs. A rejected review cannot be turned into approval.
Confirmed unapplied stale or expired table proposals receive a fresh attempt
and require fresh review. Unknown outcomes are reconciled, not retried as new
creations. Previous approvals never authorize a changed operation.

`$verify` is server-owned. It reads back every resource and all skill file bytes,
checks expected revisions and configuration, and records a verification receipt.
Only this successful step can complete the installation.

## Configuration and boundaries

The contract includes all native workflow trigger and step kinds, including
record-date schedules, webhooks, named events, code, HTTP and Slack messages.
Table mappings can use typed `table-value` literals with portable select-option
keys and seed-row references. A typed path segment such as
`["values", {"field": "title"}, "value"]` resolves the generated field ID in
row-trigger values; `["rows", "0", "values", {"field": "title"}, "value"]`
does the same for find-rows output. Ordinary strings and literal JSON are not
rewritten. Native workflows do not expose file values in run output.
For select comparisons, use an explicit value such as
`{"kind":"option","table":{"kind":"resource","resourceKind":"table","key":"leave-requests"},"field":"status","option":"draft"}`.
For multi-select fields, use `kind: "options"` with `options: ["first", "second"]`.
These compile to the installation's option IDs. A literal string remains a
literal string, not an option name.

Agent packages include policy, enrollment, separate scope and limits, built-in
or existing skill pins, MCP permission slots, Slack settings and native setup
schedules. Skill metadata stays in SKILL.md; sharing is explicit. Choosing a
sponsor or channel replacement does not bypass native consent.

Assets support UTF-8 and canonical base64, with SHA-256 and size measured over
decoded bytes. The package limit is 32 MiB of decoded assets and a JSON request
below 64 MiB (including bindings and request metadata). Each skill retains the
native 256-file, 10 MiB total and 64 KiB SKILL.md limits. Bundled files require
native file storage; script-bearing skills and code steps require configured
native runtimes. Installation does not execute scripts or workflow steps.

Provider bindings are read-only; connection creation, credential rotation and
external configuration writes are not installation operations. Only Sheets
supports an `updated` provider event. Other unsupported operations fail before
mutation. There are no arbitrary hooks, upgrades, uninstall or drift repair.
