export type OimCoreProfileVersion = "1.0" | "1.1" | "1.2";
export type OimKnowledgeProfileVersion = "1.0" | "1.1" | "1.2";
export type OimOptionalProfile = "auth" | "events" | "knowledge" | "hooks";
export type OimProfiles = {
  readonly core: OimCoreProfileVersion;
  readonly auth?: "1.0";
  readonly events?: "1.0";
  readonly knowledge?: OimKnowledgeProfileVersion;
  readonly hooks?: "1.0";
};

export type OimProfileVersionMatrix = Readonly<{
  [Profile in keyof OimProfiles]-?: readonly NonNullable<OimProfiles[Profile]>[];
}>;

export interface OimRuntimeIdentity {
  readonly name: string;
  readonly version: string;
}

export interface OimConformanceClaim {
  readonly oimVersion: "1.0";
  readonly runtime: OimRuntimeIdentity;
  readonly profiles: OimProfiles;
  readonly passedCases: readonly string[];
}

export interface OimManifest {
  readonly oimVersion: "1.0";
  readonly kind: "Integration";
  readonly metadata: {
    readonly id: string;
    readonly name: string;
    readonly version: string;
    readonly description: string;
    readonly license: string;
  };
  readonly profiles: OimProfiles;
  readonly files?: readonly {
    readonly path: string;
    readonly role: "openapi" | "graphql" | "guide" | "hook" | "fixture";
    readonly sha256: string;
  }[];
  readonly operations: readonly Record<string, unknown>[];
  readonly [key: string]: unknown;
}

export declare const OIM_ENTRYPOINT: "oim.yml";
export declare const OIM_VERSION: "1.0";
export declare const OIM_CORE_PROFILE_VERSIONS: readonly ["1.0", "1.1", "1.2"];
export declare const OIM_PROFILE_VERSIONS: Readonly<{
  core: "1.2";
  auth: "1.0";
  events: "1.0";
  knowledge: "1.2";
  hooks: "1.0";
}>;
export declare const OIM_PROFILE_VERSION_MATRIX: OimProfileVersionMatrix;
export declare const OIM_CONFORMANCE_CASES: Readonly<
  Record<"core" | OimOptionalProfile, readonly string[]>
>;
export declare const OIM_CONFORMANCE_CASE_SINCE: Readonly<Record<string, string>>;
export declare const OimManifestSchema: Readonly<Record<string, unknown>>;
export declare const OimFixtureSuiteSchema: Readonly<Record<string, unknown>>;
export declare const OimConformanceClaimSchema: Readonly<Record<string, unknown>>;

export declare class OimValidationError extends Error {}

export declare function validateManifestSource(source: string): OimManifest;
export declare function validateFixtureSuiteSource(source: string): Record<string, unknown>;
export declare function validateConformanceClaim(data: unknown): OimConformanceClaim;
export declare function validateOimManifest(data: unknown): OimManifest;
export declare function validateOimFixtureSuite(data: unknown): Record<string, unknown>;
export declare function oimManifestIssues(manifest: OimManifest): string[];
export declare function oimPackageIssues(
  manifest: OimManifest,
  files: ReadonlyMap<string, string | Uint8Array>
): string[];
export declare function oimCompatibilityIssues(previous: OimManifest, next: OimManifest): string[];
export declare function oimFileDigest(content: string | Uint8Array): string;
export declare function oimPackageDigest(manifest: OimManifest): string;
export interface OimKnowledgePrincipalBody {
  readonly template: Readonly<Record<string, unknown>>;
  readonly pointer: string;
}
export declare function oimPrincipalBody(
  binding: OimKnowledgePrincipalBody,
  externalSubject: string,
  requestSchema: Readonly<Record<string, unknown>>
): Record<string, unknown>;
export declare function oimLiveAuthorizationAllowed(response: unknown, pointer: string): boolean;
export declare function oimToolId(manifest: OimManifest, operationId: string): string;
export declare function validatePackageDirectory(
  directory: string | URL
): Promise<{ readonly manifest: OimManifest; readonly digest: string }>;
