import type { OimConformanceReport } from "./conformance.d.ts";
import type {
  OimCoreProfileVersion,
  OimOptionalProfile,
  OimProfiles,
  OimRuntimeIdentity,
} from "./index.d.ts";

export interface OimRuntimeCapabilityAdvertisement {
  readonly standard: "Open Integration Manifest";
  readonly specificationVersions: readonly ["1.0"];
  readonly packageEntrypoint: "oim.yml";
  readonly runtime: OimRuntimeIdentity;
  readonly profiles: {
    readonly core: readonly OimCoreProfileVersion[];
  } & {
    readonly [Profile in OimOptionalProfile]?: readonly NonNullable<OimProfiles[Profile]>[];
  };
  readonly conformance: {
    readonly suiteVersion: string;
    readonly suiteDigest: `sha256:${string}`;
    readonly passedCases: readonly string[];
  };
}

export declare function createRuntimeCapabilityAdvertisement(
  report: OimConformanceReport
): OimRuntimeCapabilityAdvertisement;
