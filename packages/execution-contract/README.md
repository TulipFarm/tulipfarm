# Execution contract

Provider-neutral schemas and TypeScript interfaces for chat execution. This
package has no database, filesystem, network or provider client. It does not
run commands.

## Current scope

The contract, extension slot, durable storage services and Docker adapter are
available for local qualification. Direct-host execution, worker dispatch and
chat tools are not implemented yet. Leave execution off unless developing an
adapter; passing preflight does not activate a chat feature. Saved-file routes
do not enable compute.

`@tulipfarm/config/execution` reads `TULIPFARM_EXECUTION_BACKEND`, which defaults
to `off`. Off does not read a policy file or select any registered backend.
For another mode, `TULIPFARM_EXECUTION_POLICY_FILE` must name a regular JSON file
of at most 256 KiB. Missing or invalid configuration fails startup without
printing its contents.

## Operator policy

`executionPolicySchema` defines the complete version-1 shape:

- `version`: `1`.
- `baseRevision`: a 64-character lowercase SHA-256 digest.
- `profiles`: a nonempty list of unique logical IDs and resource descriptions.
- `defaultProfile`: an ID present in that list.
- `network`: `inherited` for local mode, `public-only` for isolated modes.
- `idleTimeoutSeconds`: `300`.
- `limits`: explicit `jobTimeoutSeconds`, `queueTimeoutSeconds`,
  `stopGraceSeconds`, `checkpointIntervalSeconds`, `workspaceConcurrency`,
  `deploymentConcurrency`, `workspaceStorageBytes`, `fileBytes`, `fileCount`,
  `outputBytes`, and `jobBudgetPicoUsd`.

Numeric limits are positive safe integers. The budget is a nonnegative decimal
integer string in pico-USD; zero can represent unbilled local execution, not
permission to incur a provider charge. No resource or spending defaults are
invented. Workspace concurrency cannot exceed deployment concurrency, a file
cannot exceed its workspace quota, and checkpoint intervals cannot exceed job
timeouts.

Local profiles use `{ "kind": "shared" }`, not reserved CPU/RAM claims.
Isolated profiles use `kind: "limited"` with positive `cpuMillis`, `memoryMiB`
and `diskBytes`. Limited resources describe enforceable limits, not dedicated
physical cores. Preflight requires an exact supported profile; it never rounds
resources up. An omitted command `cwd` means the working-area root.

The config reader hashes the parsed policy and selected mode into a
`policyRevision`. Consent also binds the selected backend's declared
isolation/capabilities; changing a config file's contents
must not preserve consent merely because its path stayed the same.

## Backend boundary

An extension registers one `ExecutionBackend`. Its descriptor reports supported
profiles, isolation, network restrictions, hard deadlines, reconnection and
preview capabilities. Startup checks the declared capabilities; this is not
proof of actual enforcement. Each adapter still needs behavioral qualification.

Allocation and job operations use logical UUIDs and generation fences, never
provider IDs or arbitrary host mounts. File transfers use byte streams; output
consumers must enforce their configured byte limits. Relative path validation
does not replace descriptor-relative filesystem access, no-follow handling or
ownership checks in an actual backend.

Every operation receives an abort signal. Cancellation of a request is not proof
that a job stopped: inspect the terminal state. Unknown outcomes cannot authorize
replaying a command. The adapter's optional `shutdown` hook releases its client
resources and must not indiscriminately destroy ongoing allocations.

## Templates and held secrets

A descriptor may list `templates`, the machine images the backend can start,
and declare `capabilities.secrets`. A profile's optional `template` asks for one
of those images; `executionProfileSupported` rejects a template the descriptor
does not list.

`prepare` may carry up to eight `secrets` when the backend declares that
capability. Each has a `name`, the `value`, optional `env`, and the `hosts`,
`header` and `format` its value may be sent with. The backend keeps the value
outside the machine: the machine gets only a placeholder, in `env` when set, and
the backend's egress writes the value into the named header of HTTPS requests
to those hosts. The backend deletes the secrets when it destroys the
allocation, and also when preparing fails. Backends without the capability,
such as the Docker adapter, reject an allocation that names any secret.

## Output replay

Output events have a positive, contiguous job-local `sequence`, independent of
status-event cursors. A `chunk` contains `stdout` or `stderr` and Base64 `data`
of at most 8 KiB decoded bytes. The policy's output limit counts decoded bytes
across both streams. Binary output is preserved; text consumers decode bytes
incrementally per stream rather than treating each chunk as a complete string.

Events are immutable. Truncation appends one `truncated` event; successful
draining appends one `end` event after the process exits and both pipes reach
EOF. No chunks follow truncation, and no events follow the end marker. A
completed command must not reset its hard deadline while inherited pipes are
still open. Forced stops may leave only a partial output prefix.

Normal job completion requires both a durable output end marker and a new file
save. A confirmed forced stop instead retains the previous file save and marks
it partial; it does not fabricate a newer snapshot.

## Retained-file deletion

Execution cleanup replaces every possible chunk key with a permanent empty
object, including chunks whose upload has not arrived yet. Conditional uploads
cannot replace these markers. Cleanup verifies them before marking the database
object deleted; uncertain writes leave cleanup pending for retry. Ordinary chat
attachment deletion is unchanged.

The cleanup handler retires one chunk per leased step and saves its progress in
the database. Storage calls run outside database locks. A restarted worker
resumes at that cursor; an expired claim cannot advance it. Current saved files
remain protected, including files retained across machine replacements.

The store must enforce atomic conditional writes and overwrites. Do not expire
or delete execution markers through bucket lifecycle rules: this would let a late
upload restore deleted content. Markers retain no file bytes but still consume
object entries and storage operations.

Versioned buckets may retain earlier payload versions after an empty overwrite.
Execution writes must remain disabled until a non-versioned store is verified,
or a separate version-erasure path is qualified that preserves the current
markers. The local adapter checks do not qualify a live provider.
