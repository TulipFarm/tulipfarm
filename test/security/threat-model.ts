export const THREAT_MODEL_CATEGORIES = [
  "privilege_escalation",
  "confused_deputy",
  "prompt_injection",
  "secret_exposure",
  "replay_substitution",
  "unsafe_deserialization",
  "ssrf",
  "sql_injection",
  "command_injection",
  "sandbox_escape",
  "acl_leakage",
  "supply_chain",
  "audit_tamper",
  "admin_abuse",
] as const;

export type ThreatModelCategory = (typeof THREAT_MODEL_CATEGORIES)[number];

export interface ThreatModelControl {
  readonly category: ThreatModelCategory;
  readonly evidence: readonly string[];
}

export const THREAT_MODEL_CONTROLS: readonly ThreatModelControl[] = [
  {
    category: "privilege_escalation",
    evidence: ["packages/authz/src/effective.test.ts"],
  },
  {
    category: "confused_deputy",
    evidence: ["packages/authz/src/external-identities.test.ts"],
  },
  {
    category: "prompt_injection",
    evidence: ["apps/api/src/guardrails/pipeline.test.ts"],
  },
  {
    category: "secret_exposure",
    evidence: ["packages/secrets/src/redaction.test.ts"],
  },
  {
    category: "replay_substitution",
    evidence: [
      "packages/integrations/src/generic/webhook.test.ts",
      "packages/surface/src/action.test.ts",
    ],
  },
  {
    category: "unsafe_deserialization",
    evidence: ["packages/schema/src/registry.test.ts"],
  },
  {
    category: "ssrf",
    evidence: ["packages/integrations/src/generic/http.test.ts"],
  },
  {
    category: "sql_injection",
    evidence: ["packages/integrations/src/postgres/adapter.test.ts"],
  },
  {
    category: "command_injection",
    evidence: ["packages/sandbox/src/skill-execution.test.ts"],
  },
  {
    category: "sandbox_escape",
    evidence: ["packages/sandbox/src/backend.test.ts"],
  },
  {
    category: "acl_leakage",
    evidence: ["packages/knowledge/src/retrieve.test.ts"],
  },
  {
    category: "supply_chain",
    evidence: ["packages/integrations/src/import/mcp.test.ts"],
  },
  {
    category: "audit_tamper",
    evidence: ["packages/audit/src/verify.test.ts"],
  },
  {
    category: "admin_abuse",
    evidence: ["packages/authz/src/recertification.test.ts"],
  },
] as const;

export interface SecurityFinding {
  readonly id: string;
  readonly severity: "critical" | "high" | "medium" | "low";
  readonly status: "open" | "fixed";
  readonly category: ThreatModelCategory;
  readonly summary: string;
  readonly suppressed: boolean;
}

/** No known release finding; new findings must be recorded here. */
export const RELEASE_FINDINGS: readonly SecurityFinding[] = [];

export function assertThreatModelReleaseGate(findings: readonly SecurityFinding[]): void {
  const suppressed = findings.find((finding) => finding.suppressed);
  if (suppressed) throw new Error(`suppressed security finding: ${suppressed.id}`);
  const critical = findings.find(
    (finding) => finding.severity === "critical" && finding.status === "open"
  );
  if (critical) throw new Error(`release-blocking security finding: ${critical.id}`);
}
