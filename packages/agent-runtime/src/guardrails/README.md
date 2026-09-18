# Guardrail execution

The existing four-stage pipeline runs pattern-based checks over input, Tool calls, Tool results,
and output. `GuardrailsService.init` validates business configuration and atomically replaces
compiled stages. Missing or invalid business configuration resolves to `DEFAULT_GUARDRAILS`.

## Platform intersection

`platformGuardrailsFor` selects the runtime-owned built-in floor for TulipFarm hosting. Independent
hosting returns no platform override and retains the existing valid-custom-policy behavior.
`GuardrailsService` snapshots its optional platform policy at construction; reloads cannot replace
it. `intersectGuardrails` runs the union of restrictions in each stage, deduplicating exact checks.
Every supported check blocks or transforms toward less disclosure; no allow rule can undo a block.
Unknown checks and unsupported fields are rejected by the existing strict per-stage schema.

The floor is code-owned, not an environment-supplied policy language or a customer Soul file.
This release has no editable platform-floor surface and no production hosted identity verifier.

## Composition and reload

The API constructs the service from validated deployment hosting authority. `guardrail_forge`
adds one strict-schema guard through the authorized Soul writer and requires a live reload hook.
The hook rebuilds the service before reporting enforcement. Git down-sync also rebuilds it on
`soul.synced`. No removal or replacement changeset endpoint is implemented.

The administration read model reads this same effective service, not raw Soul configuration.
Chat and sub-agent Contexts transport the policy and its digest to `TurnGuardrails`. Routine
Agent States fetch the current policy through their Run-authorized internal Agent catalog
endpoint; the Worker validates the schema and digest and refuses a failed fetch. Existing
execution snapshots remain fixed; subsequent execution starts read the reloaded policy.

Stage restrictions supplement, never replace, live HTTP/Tool authority intersection, Tool
approvals, Run permission ceilings, mutation kill switches, and production sandbox checks.
