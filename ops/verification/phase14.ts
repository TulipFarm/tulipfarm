export interface VerificationSignal {
  id:
    | "test"
    | "lint"
    | "typecheck"
    | "build"
    | "compose"
    | "chat"
    | "webhook"
    | "schedule"
    | "effect"
    | "acl-deny"
    | "restore";
  status: "passed";
  evidence: string;
}

export const PHASE_14_VERIFICATION: readonly VerificationSignal[] = [
  {
    id: "test",
    status: "passed",
    evidence: "API: 182 files/1,793 tests with one worker; remaining Turbo graph: 26/26 tasks.",
  },
  {
    id: "lint",
    status: "passed",
    evidence: "pnpm lint: 28/28 tasks.",
  },
  {
    id: "typecheck",
    status: "passed",
    evidence: "pnpm run typecheck: 28/28 tasks.",
  },
  {
    id: "build",
    status: "passed",
    evidence: "pnpm run build: 5/5 build tasks.",
  },
  {
    id: "compose",
    status: "passed",
    evidence: "Isolated production app and bundled PostgreSQL containers reported healthy.",
  },
  {
    id: "chat",
    status: "passed",
    evidence:
      "Live Chat request returned X-Run-Id from the durable invocation gateway before the " +
      "expected unconfigured-provider response.",
  },
  {
    id: "webhook",
    status: "passed",
    evidence: "Ingress route smoke: 14/14 webhook acceptance, denial, and deduplication cases.",
  },
  {
    id: "schedule",
    status: "passed",
    evidence: "Run Kernel scheduler smoke: 24/24 cases.",
  },
  {
    id: "effect",
    status: "passed",
    evidence: "Tool effect dispatch, reconciliation, and security smoke: 11/11 cases.",
  },
  {
    id: "acl-deny",
    status: "passed",
    evidence: "Live unauthenticated Knowledge page request was denied with HTTP 401.",
  },
  {
    id: "restore",
    status: "passed",
    evidence:
      "Backup checksums and Soul bundle verified; PostgreSQL, Soul, blob, and key metadata " +
      "restored into isolated disposable targets.",
  },
] as const;
