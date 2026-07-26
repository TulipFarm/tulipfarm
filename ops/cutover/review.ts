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
] as const;

export const PHASE_14_REVIEW: readonly ReviewSection[] = [
  {
    category: "Security",
    findings: [],
    evidence: [
      "test/security/threat-model.test.ts",
      "scripts/legacy-removal.test.ts",
      "packages/tool-broker/src/effects/dispatch.test.ts",
    ],
  },
  {
    category: "Correctness",
    findings: [],
    evidence: [
      "apps/api/src/runtime/invocation-gateway.test.ts",
      "apps/api/src/runtime/invocation-store.pg.test.ts",
    ],
  },
  {
    category: "Performance",
    findings: [],
    evidence: [
      "test/performance/load-profile.test.ts",
      "packages/observability/src/backpressure.ts",
    ],
  },
  {
    category: "Design",
    findings: [],
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
      "absolute-simplify unavailable on PATH",
    ],
  },
] as const;
