import type { OimConformanceClaim, OimProfiles, OimRuntimeIdentity } from "./index.d.ts";

export interface OimConformanceVector {
  readonly id: string;
  readonly caseId: string;
  readonly profile: keyof OimProfiles;
  readonly profileVersion: string;
  readonly since?: string;
  readonly input: unknown;
}

export interface OimConformanceAdapter {
  runCase(vector: OimConformanceVector): Promise<unknown> | unknown;
}

export interface OimConformanceResult {
  readonly caseId: string;
  readonly vectorId: string;
  readonly status: "passed" | "failed";
  readonly detail?: string;
}

export interface OimConformanceExecutionReport {
  readonly oimVersion: "1.0";
  readonly suiteVersion: string;
  readonly suiteDigest: `sha256:${string}`;
  readonly runtime: OimRuntimeIdentity;
  readonly profiles: OimProfiles;
  readonly results: readonly OimConformanceResult[];
}

export interface OimConformanceReport extends OimConformanceExecutionReport {
  readonly claim: OimConformanceClaim;
}

export declare class OimConformanceError extends Error {
  readonly report: OimConformanceExecutionReport;
}

export declare function runConformance(input: {
  readonly runtime: OimRuntimeIdentity;
  readonly profiles: OimProfiles;
  readonly adapter: OimConformanceAdapter;
}): Promise<OimConformanceReport>;
