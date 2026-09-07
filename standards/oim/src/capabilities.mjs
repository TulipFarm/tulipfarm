import {
  OIM_ENTRYPOINT,
  OIM_PROFILE_VERSION_MATRIX,
  OIM_VERSION,
  OimValidationError,
  validateConformanceClaim,
} from "./index.mjs";
import { conformanceSuite, conformanceSuiteDigest, requiredConformanceVectors } from "./suite.mjs";

export function createRuntimeCapabilityAdvertisement(report) {
  if (!report || typeof report !== "object" || !report.claim) {
    throw new OimValidationError("an executed conformance report is required");
  }
  const claim = validateConformanceClaim(report.claim);
  if (
    JSON.stringify(report.runtime) !== JSON.stringify(claim.runtime) ||
    JSON.stringify(report.profiles) !== JSON.stringify(claim.profiles)
  ) {
    throw new OimValidationError("conformance report and claim do not match");
  }
  if (
    report.oimVersion !== OIM_VERSION ||
    report.suiteVersion !== conformanceSuite.version ||
    report.suiteDigest !== conformanceSuiteDigest
  ) {
    throw new OimValidationError("conformance report metadata is invalid");
  }
  const passedResults = new Set(
    (report.results ?? [])
      .filter((result) => result.status === "passed")
      .map((result) => `${result.caseId}\0${result.vectorId}`)
  );
  const requiredResults = requiredConformanceVectors(claim.profiles);
  if (
    report.results?.some((result) => result.status !== "passed") ||
    requiredResults.some((vector) => !passedResults.has(`${vector.caseId}\0${vector.id}`))
  ) {
    throw new OimValidationError("report does not prove every claimed case");
  }

  const profiles = {};
  for (const [profile, version] of Object.entries(claim.profiles)) {
    profiles[profile] = OIM_PROFILE_VERSION_MATRIX[profile].filter(
      (candidate) => Number(candidate) <= Number(version)
    );
  }

  return {
    standard: "Open Integration Manifest",
    specificationVersions: [OIM_VERSION],
    packageEntrypoint: OIM_ENTRYPOINT,
    runtime: claim.runtime,
    profiles,
    conformance: {
      suiteVersion: report.suiteVersion,
      suiteDigest: report.suiteDigest,
      passedCases: claim.passedCases,
    },
  };
}
