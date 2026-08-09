import { readFileSync } from "node:fs";
import type {
  CandidateRejectionReason,
  MemoryCandidate,
  MemoryCandidateSignals,
  MemoryConfirmationState,
  MemoryExclusionReason,
  MemoryOrigin,
  MemoryStatus,
  MemoryTrustTier,
  MemoryType,
} from "../../src";

export interface GoldenMessage {
  readonly role: string;
  readonly content: string;
}

export interface GoldenMemoryCandidate extends MemoryCandidate {
  readonly id: string;
}

export interface GoldenExtractionCase {
  readonly id: string;
  readonly title: string;
  readonly messages: readonly GoldenMessage[];
  readonly injectionFragments?: readonly string[];
  readonly candidates: readonly GoldenMemoryCandidate[];
  readonly expected: {
    readonly proposed: readonly string[];
    readonly rejected: readonly {
      readonly id: string;
      readonly reason: CandidateRejectionReason | string;
    }[];
  };
}

export interface GoldenRecallAssertion {
  readonly id: string;
  readonly targetPrincipalId?: string;
  readonly subject: string;
  readonly statement: string;
  readonly memoryType: MemoryType;
  readonly trustTier: MemoryTrustTier;
  readonly confidence: number;
  readonly importance: number;
  readonly origin: MemoryOrigin;
  readonly authorPrincipalId: string;
  readonly confirmation?: MemoryConfirmationState;
  readonly status?: MemoryStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly validFrom: string;
  readonly validTo?: string;
  readonly expiresAt?: string;
  readonly entities: readonly string[];
}

export interface GoldenRecallCase {
  readonly id: string;
  readonly title: string;
  readonly now: string;
  readonly principalId: string;
  readonly query?: string;
  readonly limit: number;
  readonly useIndex: boolean;
  readonly corpus: readonly GoldenRecallAssertion[];
  readonly signals: readonly MemoryCandidateSignals[];
  readonly expected: {
    readonly order: readonly string[];
    readonly exclusions?: readonly {
      readonly reason: MemoryExclusionReason;
      readonly count: number;
    }[];
  };
}

export interface GoldenSupersessionEvent {
  readonly id: string;
  readonly at: string;
  readonly subject: string;
  readonly statement: string;
  readonly memoryType: MemoryType;
  readonly trustTier: MemoryTrustTier;
  readonly origin: MemoryOrigin;
  readonly confidence: number;
  readonly importance: number;
  readonly validFrom: string;
  readonly entities: readonly string[];
}

export interface GoldenSupersessionCase {
  readonly id: string;
  readonly title: string;
  readonly principalId: string;
  readonly judge: "always" | "employer-only" | "never";
  readonly events: readonly GoldenSupersessionEvent[];
  readonly now: string;
  readonly expected: {
    readonly currentOrder: readonly string[];
    readonly historical: readonly {
      readonly validAt: string;
      readonly order: readonly string[];
    }[];
    readonly statuses: readonly {
      readonly id: string;
      readonly status: MemoryStatus;
      readonly validTo?: string;
    }[];
  };
}

export interface GoldenFixtures {
  readonly extractionCases: readonly GoldenExtractionCase[];
  readonly recallCases: readonly GoldenRecallCase[];
  readonly supersessionCases: readonly GoldenSupersessionCase[];
}

export function loadGoldenFixtures(): GoldenFixtures {
  return JSON.parse(readFileSync(new URL("./fixtures.json", import.meta.url), "utf8"));
}

export const goldenFixtures = loadGoldenFixtures();
