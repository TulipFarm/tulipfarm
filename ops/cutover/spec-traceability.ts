export interface TraceabilityEntry {
  id: string;
  requirement: string;
  status: "met";
  evidence: readonly string[];
}

export const PHASE_14_TRACEABILITY: {
  sections: readonly TraceabilityEntry[];
  invariants: readonly TraceabilityEntry[];
  cutoverCriteria: readonly TraceabilityEntry[];
} = {
  sections: [
    {
      id: "20",
      requirement: "Audit, retention, and compliance-oriented controls",
      status: "met",
      evidence: [
        "packages/audit/src/verify.test.ts",
        "apps/docs/content/docs/security/control-evidence.mdx",
        "apps/docs/content/docs/security/privacy.mdx",
      ],
    },
    {
      id: "21",
      requirement: "Permission-safe product and operational user experiences",
      status: "met",
      evidence: [
        "apps/web/app/routes/_app.approvals.tsx",
        "apps/web/app/routes/_app.runs.$id.tsx",
        "apps/web/app/routes/_app.admin.guardrails.tsx",
      ],
    },
    {
      id: "22",
      requirement: "Operations, observability, resilience, recovery, and load posture",
      status: "met",
      evidence: [
        "packages/observability/src/resilience.test.ts",
        "test/performance/load-profile.test.ts",
        "ops/resilience/README.md",
      ],
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
      status: "met",
      evidence: [
        "scripts/phase14-review.test.ts",
        "scripts/legacy-removal.test.ts",
        "scripts/resilience-contract.test.ts",
      ],
    },
    {
      id: "26",
      requirement: "Ordered rebuild, unified cutover, and legacy removal",
      status: "met",
      evidence: [
        "apps/api/src/runtime/invocation-gateway.test.ts",
        "scripts/cutover-contract.test.ts",
        "scripts/legacy-removal.test.ts",
      ],
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
      status: "met",
      evidence: ["packages/soul/src/changeset.test.ts", "packages/soul/src/publication.test.ts"],
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
      status: "met",
      evidence: [
        "apps/api/src/runtime/invocation-gateway.test.ts",
        "apps/api/src/runtime/invocation-store.pg.test.ts",
      ],
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
      status: "met",
      evidence: [
        "packages/soul/src/changeset.test.ts",
        "packages/soul/src/agent-publication.test.ts",
        "packages/soul/src/converters/legacy-definitions.test.ts",
      ],
    },
    {
      id: "C-02",
      requirement: "Chat and every Trigger class create the same Run and State records",
      status: "met",
      evidence: ["apps/api/src/runtime/invocation-gateway.test.ts"],
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
      status: "met",
      evidence: [
        "apps/worker/src/run-dispatcher.test.ts",
        "packages/tool-broker/src/effects/reconcile.test.ts",
      ],
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
      status: "met",
      evidence: ["scripts/legacy-removal.test.ts", "apps/api/src/legacy-inventory.test.ts"],
    },
  ],
};
