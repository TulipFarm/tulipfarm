export type ReviewCategory =
  | "Security"
  | "Correctness"
  | "Performance"
  | "Design"
  | "Readability"
  | "Convention"
  | "Testing";

export interface ReviewFinding {
  severity: "MAJOR" | "MINOR";
  summary: string;
  disposition: "fixed" | "deferred";
  evidence: string;
  reason?: string;
}

export interface ReviewSection {
  category: ReviewCategory;
  findings: ReviewFinding[];
  evidence: string[];
}

export const PHASE_14_RESOLVED_MAJORS: readonly ReviewFinding[] = [
  {
    severity: "MAJOR",
    summary: "Tool Approval decisions were process-memory authoritative.",
    disposition: "fixed",
    evidence: "apps/api/src/approvals/chat-gate.ts; apps/api/src/approvals/repo.pg.test.ts",
  },
  {
    severity: "MAJOR",
    summary: "Published Soul artifacts could be silently skipped after load failures.",
    disposition: "fixed",
    evidence: "packages/soul/src/published-loader.ts; packages/soul/src/soul-loader.test.ts",
  },
  {
    severity: "MAJOR",
    summary: "The runtime retained a pre-cutover secret-key decryption fallback.",
    disposition: "fixed",
    evidence: "packages/secrets/src/encrypted-store.ts; packages/secrets/src/service.test.ts",
  },
  {
    severity: "MAJOR",
    summary: "Phase 14 verification evidence was self-declared rather than run-derived.",
    disposition: "fixed",
    evidence:
      "ops/verification/phase14.ts; ops/verification/runner.ts; " +
      "scripts/run-phase14-verification.ts; scripts/phase14-verification.test.ts",
  },
] as const;

export const PHASE_14_REVIEW: readonly ReviewSection[] = [
  {
    category: "Security",
    findings: [
      {
        severity: "MAJOR",
        summary: "Production Soul authoring bypasses the changeset validation gateway.",
        disposition: "deferred",
        evidence:
          "apps/api/src/soul/agents/tools.ts; apps/api/src/soul/skills/tools.ts; " +
          "apps/api/src/soul/resource-types/routes.ts",
        reason:
          "Each authoring surface must be migrated to the package Soul gateway before cutover.",
      },
    ],
    evidence: [
      "test/security/threat-model.test.ts",
      "scripts/legacy-removal.test.ts",
      "packages/tool-broker/src/effects/dispatch.test.ts",
    ],
  },
  {
    category: "Correctness",
    findings: [
      {
        severity: "MAJOR",
        summary: "Chat records a Run but executes the Turn inline without durable worker States.",
        disposition: "deferred",
        evidence: "apps/api/src/chat/routes.ts; apps/api/src/runtime/chat-run.ts",
        reason:
          "The request payload must become an Artifact and worker-owned State before inline " +
          "execution can be removed.",
      },
      {
        severity: "MAJOR",
        summary: "Legacy API-owned jobs and direct Tool execution remain authoritative.",
        disposition: "deferred",
        evidence:
          "apps/api/src/routines/jobs.ts; apps/api/src/routines/schedules.ts; " +
          "apps/api/src/routines/action-executor.ts",
        reason: "Routine scheduling and effects require migration to Run Kernel and Tool Broker.",
      },
    ],
    evidence: [
      "apps/api/src/runtime/invocation-gateway.test.ts",
      "apps/api/src/runtime/invocation-store.pg.test.ts",
    ],
  },
  {
    category: "Performance",
    findings: [
      {
        severity: "MAJOR",
        summary: "The required scenario load and recovery targets have no measured load run.",
        disposition: "deferred",
        evidence: "test/performance/load-profile.test.ts",
        reason:
          "Current evidence exercises an in-memory admission contract and does not generate " +
          "ingress, waits, fan-out, SSE, or provider load.",
      },
    ],
    evidence: [
      "test/performance/load-profile.test.ts",
      "packages/observability/src/backpressure.ts",
    ],
  },
  {
    category: "Design",
    findings: [
      {
        severity: "MAJOR",
        summary: "Worker applications are libraries, not bootable authoritative processes.",
        disposition: "deferred",
        evidence: "apps/worker/src/index.ts; apps/integration-worker/src/index.ts",
        reason:
          "Both entrypoints need production dependency composition, lifecycle, health, and " +
          "dispatch loops.",
      },
    ],
    evidence: ["ops/cutover/contract.ts", "scripts/cutover-contract.test.ts"],
  },
  {
    category: "Readability",
    findings: [],
    evidence: ["pnpm exec biome check ."],
  },
  {
    category: "Convention",
    findings: [],
    evidence: ["metadata/terminologies.md", "scripts/legacy-removal.test.ts"],
  },
  {
    category: "Testing",
    findings: [],
    evidence: [
      "pnpm test",
      "scripts/phase14-review.test.ts",
      "scripts/phase14-verification.test.ts",
      "absolute-simplify unavailable on PATH",
    ],
  },
] as const;

export const PHASE_14_RELEASE_READY = PHASE_14_REVIEW.every((section) =>
  section.findings.every(
    (finding) => finding.severity !== "MAJOR" || finding.disposition === "fixed"
  )
);
