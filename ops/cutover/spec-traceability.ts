export interface TraceabilityEntry {
  id: string;
  requirement: string;
  status: "met" | "blocked";
  evidence: readonly string[];
  blocker?: string;
}

export const PHASE_14_TRACEABILITY: {
  sections: readonly TraceabilityEntry[];
  invariants: readonly TraceabilityEntry[];
  cutoverCriteria: readonly TraceabilityEntry[];
} = {
  sections: [
    {
      id: "1",
      requirement: "Durable AI business harness summary",
      status: "met",
      evidence: ["docs/architecture/boundaries.md"],
    },
    {
      id: "2",
      requirement: "Current-state assessment and explicit adapt-or-replace decisions",
      status: "met",
      evidence: ["docs/architecture/legacy-inventory.md", "docs/architecture/decision-index.md"],
    },
    {
      id: "3",
      requirement: "Approved product goals",
      status: "met",
      evidence: ["docs/architecture/boundaries.md", "scripts/spec-traceability.test.ts"],
    },
    {
      id: "4",
      requirement: "Non-goals and deferred scope remain bounded",
      status: "met",
      evidence: ["docs/architecture/decision-index.md"],
    },
    {
      id: "5",
      requirement: "Release-blocking architectural invariants",
      status: "blocked",
      evidence: [
        "docs/architecture/boundaries.md",
        "apps/api/src/runtime/invocation-gateway.test.ts",
      ],
      blocker:
        "Production Soul writes and Turn execution still bypass governed runtime boundaries.",
    },
    {
      id: "6",
      requirement: "System shape, package ownership, and dependency direction",
      status: "met",
      evidence: ["docs/architecture/dependency-rules.md", "scripts/lib/architecture-rules.test.ts"],
    },
    {
      id: "7",
      requirement: "Canonical authored and runtime domain model",
      status: "met",
      evidence: [
        "packages/schema/src/definitions/contracts.test.ts",
        "packages/storage/src/runs/run-store.pg.test.ts",
      ],
    },
    {
      id: "8",
      requirement: "Soul changesets, publication, and immutable bundle loading",
      status: "blocked",
      evidence: [
        "packages/soul/src/changeset.test.ts",
        "packages/soul/src/publication.test.ts",
        "packages/soul/src/soul-loader.test.ts",
      ],
      blocker: "Production authoring routes still write directly to the Soul filesystem and Git.",
    },
    {
      id: "9",
      requirement: "Durable Routine and Trigger model",
      status: "blocked",
      evidence: [
        "packages/run-kernel/src/routine/compiler.test.ts",
        "packages/run-kernel/src/triggers/scheduler.test.ts",
        "apps/worker/test/e2e/github-jira-triage/triage.test.ts",
      ],
      blocker: "Legacy Routine pg-boss consumers still run inside the API process.",
    },
    {
      id: "10",
      requirement: "Bounded, durable Agent runtime",
      status: "blocked",
      evidence: [
        "packages/agent-runtime/src/loop/loop.test.ts",
        "apps/worker/src/agent-state.test.ts",
      ],
      blocker: "Chat executes its Agent loop in the API instead of through the durable worker.",
    },
    {
      id: "11",
      requirement: "Governed Tools, Guardrails, Approvals, and effects",
      status: "blocked",
      evidence: [
        "packages/tool-broker/src/broker.test.ts",
        "packages/tool-broker/src/approval-gate.test.ts",
        "packages/tool-broker/src/effects/dispatch.test.ts",
      ],
      blocker: "Production Routine and ingress paths can execute Tools outside the Tool Broker.",
    },
    {
      id: "12",
      requirement: "Identity, authorization, and external principals",
      status: "met",
      evidence: [
        "packages/authz/test/security-matrix/authorization-isolation.test.ts",
        "apps/api/src/identity/routes.test.ts",
      ],
    },
    {
      id: "13",
      requirement: "Secret Broker and strong production sandbox boundaries",
      status: "met",
      evidence: [
        "packages/secrets/src/broker.test.ts",
        "packages/sandbox/test/security/skill-boundary.security.test.ts",
      ],
    },
    {
      id: "14",
      requirement: "ACL-first Knowledge and scoped confirmed Memory",
      status: "blocked",
      evidence: [
        "packages/knowledge/test/security/leakage.test.ts",
        "packages/memory/test/security/leakage.test.ts",
      ],
      blocker: "The governed Knowledge and Memory packages are not composed into production apps.",
    },
    {
      id: "15",
      requirement: "Governed Integrations and durable channels",
      status: "blocked",
      evidence: [
        "packages/integrations/test/conformance/external-isolation.test.ts",
        "packages/integrations/src/channels/security.test.ts",
      ],
      blocker: "The Integration Worker entrypoint has no production boot or dispatch loop.",
    },
    {
      id: "16",
      requirement: "Safe A2UI, resumable forms, and immutable Artifacts",
      status: "met",
      evidence: [
        "packages/a2ui/src/action.test.ts",
        "packages/a2ui/src/forms/service.test.ts",
        "packages/run-kernel/src/artifacts.test.ts",
      ],
    },
    {
      id: "17",
      requirement: "Constraint-preserving ModelProfile routing",
      status: "met",
      evidence: [
        "packages/agent-runtime/src/models/profile.test.ts",
        "packages/agent-runtime/src/models/router.test.ts",
      ],
    },
    {
      id: "18",
      requirement: "Versioned HTTP, SSE, and event interfaces",
      status: "met",
      evidence: ["apps/api/src/openapi.test.ts", "apps/api/src/runs/events.test.ts"],
    },
    {
      id: "19",
      requirement: "PostgreSQL correctness and persistence constraints",
      status: "met",
      evidence: [
        "packages/storage/src/runs/run-store.pg.test.ts",
        "packages/storage/src/events/event-store.pg.test.ts",
      ],
    },
    {
      id: "20",
      requirement: "Audit, retention, and compliance-oriented controls",
      status: "blocked",
      evidence: [
        "packages/audit/src/verify.test.ts",
        "apps/docs/content/docs/security/control-evidence.mdx",
        "apps/docs/content/docs/security/privacy.mdx",
      ],
      blocker: "The governed Audit package is not composed into production applications.",
    },
    {
      id: "21",
      requirement: "Permission-safe product and operational user experiences",
      status: "met",
      evidence: [
        "apps/web/app/components/operations/operations-console.test.tsx",
        "apps/web/app/routes/_app.approvals.tsx",
        "apps/web/app/routes/_app.runs.$id.tsx",
        "apps/web/app/routes/_app.admin.guardrails.tsx",
      ],
    },
    {
      id: "22",
      requirement: "Operations, observability, resilience, recovery, and load posture",
      status: "blocked",
      evidence: [
        "packages/observability/src/resilience.test.ts",
        "test/performance/load-profile.test.ts",
        "ops/resilience/README.md",
      ],
      blocker:
        "Load evidence is an in-memory contract test rather than the required scenario load run.",
    },
    {
      id: "23",
      requirement: "Durable, bounded, idempotent, and reconciled failure handling",
      status: "met",
      evidence: [
        "packages/run-kernel/src/resume.test.ts",
        "packages/tool-broker/src/effects/reconcile.test.ts",
        "apps/worker/src/run-dispatcher.test.ts",
      ],
    },
    {
      id: "24",
      requirement: "Threat boundaries are modeled and tested fail closed",
      status: "met",
      evidence: ["test/security/threat-model.test.ts"],
    },
    {
      id: "25",
      requirement: "Layered verification and production gates",
      status: "blocked",
      evidence: [
        "scripts/phase14-review.test.ts",
        "scripts/legacy-removal.test.ts",
        "scripts/resilience-contract.test.ts",
      ],
      blocker:
        "Verification status is declared in constants and is not derived from recorded runs.",
    },
    {
      id: "26",
      requirement: "Ordered rebuild, unified cutover, and legacy removal",
      status: "blocked",
      evidence: [
        "apps/api/src/runtime/invocation-gateway.test.ts",
        "scripts/cutover-contract.test.ts",
        "scripts/legacy-removal.test.ts",
      ],
      blocker:
        "Legacy behavior remains under renamed paths and separate workers are not authoritative.",
    },
    {
      id: "27",
      requirement: "Approved design decisions and rejected alternatives",
      status: "met",
      evidence: ["docs/architecture/decision-index.md"],
    },
    {
      id: "28",
      requirement: "No unresolved blocking architecture questions",
      status: "blocked",
      evidence: ["docs/architecture/decision-index.md"],
      blocker: "Production composition and cutover ownership remain unresolved.",
    },
    {
      id: "29",
      requirement: "Specification approval and task-package contract",
      status: "met",
      evidence: ["docs/architecture/boundaries.md", "scripts/spec-traceability.test.ts"],
    },
  ],
  invariants: [
    {
      id: "I-01",
      requirement: "One business per deployment with explicit persisted business boundaries",
      status: "met",
      evidence: ["packages/authz/src/principals.test.ts"],
    },
    {
      id: "I-02",
      requirement: "External principals resolve before work and cannot substitute identities",
      status: "met",
      evidence: [
        "packages/authz/src/external-identities.test.ts",
        "apps/api/src/runtime/invocation-gateway.test.ts",
      ],
    },
    {
      id: "I-03",
      requirement: "Effective authority is an intersection and cannot be amplified",
      status: "met",
      evidence: ["packages/authz/src/effective.test.ts"],
    },
    {
      id: "I-04",
      requirement: "Skills never grant Tool capabilities",
      status: "met",
      evidence: ["packages/soul/src/capability-analysis.ts"],
    },
    {
      id: "I-05",
      requirement: "Every authored write uses the Soul changeset and validation gateway",
      status: "blocked",
      evidence: ["packages/soul/src/changeset.test.ts", "packages/soul/src/publication.test.ts"],
      blocker: "API Agent, Skill, Resource Type, and LLM configuration paths write Soul directly.",
    },
    {
      id: "I-06",
      requirement: "Runtime definitions come from immutable content-hashed bundles",
      status: "met",
      evidence: ["packages/soul/src/bundle.test.ts", "packages/soul/src/soul-loader.test.ts"],
    },
    {
      id: "I-07",
      requirement: "Every Turn and automation creates a durable Run and States",
      status: "blocked",
      evidence: [
        "apps/api/src/runtime/invocation-gateway.test.ts",
        "apps/api/src/runtime/invocation-store.pg.test.ts",
      ],
      blocker: "Chat creates a Run record but executes the Turn inline without durable States.",
    },
    {
      id: "I-08",
      requirement: "State outputs are immutable typed references",
      status: "met",
      evidence: ["packages/run-kernel/src/outputs.ts", "packages/run-kernel/src/lineage.test.ts"],
    },
    {
      id: "I-09",
      requirement: "Effects use stable idempotency and reconcile ambiguity",
      status: "met",
      evidence: [
        "packages/tool-broker/src/effects/store.test.ts",
        "packages/tool-broker/src/effects/reconcile.test.ts",
      ],
    },
    {
      id: "I-10",
      requirement: "Secrets stay opaque until authorized Tool dispatch",
      status: "met",
      evidence: [
        "packages/secrets/src/broker.test.ts",
        "packages/secrets/src/redaction.test.ts",
        "packages/secrets/src/service.test.ts",
      ],
    },
    {
      id: "I-11",
      requirement: "Knowledge authorization precedes candidates and content return",
      status: "met",
      evidence: ["packages/knowledge/test/security/leakage.test.ts"],
    },
    {
      id: "I-12",
      requirement: "Untrusted content cannot become authority or trusted instruction",
      status: "met",
      evidence: ["test/security/threat-model.test.ts"],
    },
    {
      id: "I-13",
      requirement: "Approval binds exact intent and Guardrail revision",
      status: "met",
      evidence: [
        "packages/authz/src/approval/binding.test.ts",
        "packages/tool-broker/src/approval-gate.test.ts",
      ],
    },
    {
      id: "I-14",
      requirement: "Published definitions and Run/effect evidence are immutable versions",
      status: "met",
      evidence: [
        "packages/soul/src/bundle.test.ts",
        "packages/tool-broker/src/effects/store.test.ts",
      ],
    },
    {
      id: "I-15",
      requirement: "Audit is append-only, hash-linked, sealable, and cryptographically erasable",
      status: "met",
      evidence: [
        "packages/audit/src/chain.test.ts",
        "packages/audit/src/seal.test.ts",
        "packages/audit/src/erase.test.ts",
      ],
    },
    {
      id: "I-16",
      requirement: "Optional infrastructure is never required for correctness",
      status: "met",
      evidence: ["packages/storage/src/ports/transaction.test.ts"],
    },
  ],
  cutoverCriteria: [
    {
      id: "C-01",
      requirement: "Every UI/API/Agent/import write reaches the Soul gateway",
      status: "blocked",
      evidence: [
        "packages/soul/src/changeset.test.ts",
        "packages/soul/src/agent-publication.test.ts",
        "packages/soul/src/converters/legacy-definitions.test.ts",
      ],
      blocker: "Production API authoring paths still mutate Soul files and Git directly.",
    },
    {
      id: "C-02",
      requirement: "Chat and every Trigger class create the same Run and State records",
      status: "blocked",
      evidence: ["apps/api/src/runtime/invocation-gateway.test.ts"],
      blocker: "The Chat gateway does not dispatch the Turn as worker-owned durable States.",
    },
    {
      id: "C-03",
      requirement: "External-user mapping cannot execute as another user",
      status: "met",
      evidence: [
        "packages/authz/src/external-identities.test.ts",
        "apps/api/src/runtime/invocation-gateway.test.ts",
      ],
    },
    {
      id: "C-04",
      requirement: "Private source content never reaches unauthorized candidates or outputs",
      status: "met",
      evidence: ["packages/knowledge/test/security/leakage.test.ts"],
    },
    {
      id: "C-05",
      requirement: "Duplicate GitHub delivery creates one logical Run and idempotent effects",
      status: "met",
      evidence: [
        "apps/api/src/ingress/github-parity.fixture.test.ts",
        "packages/tool-broker/src/effects/store.test.ts",
      ],
    },
    {
      id: "C-06",
      requirement: "Worker death during an approved side effect reaches reconciliation",
      status: "blocked",
      evidence: [
        "apps/worker/src/run-dispatcher.test.ts",
        "packages/tool-broker/src/effects/reconcile.test.ts",
      ],
      blocker:
        "The Worker entrypoint exports components but does not boot an authoritative process.",
    },
    {
      id: "C-07",
      requirement: "Secret rotation and revocation affect next use without plaintext leakage",
      status: "met",
      evidence: [
        "packages/secrets/src/key-manager.test.ts",
        "packages/secrets/src/broker.test.ts",
        "packages/secrets/src/redaction.test.ts",
      ],
    },
    {
      id: "C-08",
      requirement: "Docker Compose backup recovery is exercised and documented",
      status: "met",
      evidence: ["ops/resilience/restore.sh", "apps/docs/content/docs/guides/recovery.mdx"],
    },
    {
      id: "C-09",
      requirement: "Legacy routes and workers are removed as bypass paths",
      status: "blocked",
      evidence: ["scripts/legacy-removal.test.ts", "apps/api/src/legacy-inventory.test.ts"],
      blocker: "In-process jobs, direct Soul writes, and direct Tool execution remain in the API.",
    },
  ],
};
