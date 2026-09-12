import { isDeepStrictEqual } from "node:util";
import {
  OIM_CONFORMANCE_CASES,
  OIM_PROFILE_VERSION_MATRIX,
  OIM_VERSION,
  OimValidationError,
  validateConformanceClaim,
} from "./index.mjs";
import { conformanceSuite, conformanceSuiteDigest, requiredConformanceVectors } from "./suite.mjs";

export class OimConformanceError extends Error {
  constructor(message, report) {
    super(message);
    this.name = "OimConformanceError";
    this.report = report;
  }
}

export async function runConformance({ runtime, profiles, adapter }) {
  validateProfileSelection(profiles);
  if (!adapter || typeof adapter.runCase !== "function") {
    throw new OimValidationError("adapter.runCase must exercise the runtime under test");
  }

  const requiredCases = requiredCaseIds(profiles);
  const results = [];
  const passedCases = [];

  for (const caseId of requiredCases) {
    const definition = conformanceSuite.cases.find((candidate) => candidate.id === caseId);
    if (!definition) {
      throw new OimConformanceError(`suite is missing required case ${caseId}`, {
        results,
      });
    }
    const vectors = requiredConformanceVectors(profiles).filter(
      (vector) => vector.caseId === caseId
    );
    if (vectors.length === 0) {
      throw new OimConformanceError(`suite has no applicable vector for ${caseId}`, {
        results,
      });
    }

    let casePassed = true;
    for (const vector of vectors) {
      let actual;
      let status = "failed";
      let detail;
      try {
        const { expect, ...portableVector } = vector;
        actual = await adapter.runCase({
          ...portableVector,
          caseId,
          profile: definition.profile,
          profileVersion: profiles[definition.profile],
        });
        if (actual?.skipped === true) {
          detail = "adapter skipped required behavior";
        } else if (isDeepStrictEqual(actual, vector.expect)) {
          status = "passed";
        } else {
          detail = `expected ${JSON.stringify(vector.expect)}, received ${JSON.stringify(actual)}`;
        }
      } catch (error) {
        detail = error instanceof Error ? error.message : String(error);
      }
      results.push({ caseId, vectorId: vector.id, status, ...(detail ? { detail } : {}) });
      if (status !== "passed") casePassed = false;
    }
    if (casePassed) passedCases.push(caseId);
  }

  const report = {
    oimVersion: OIM_VERSION,
    suiteVersion: conformanceSuite.version,
    suiteDigest: conformanceSuiteDigest,
    runtime,
    profiles,
    results,
  };
  if (results.some((result) => result.status !== "passed")) {
    throw new OimConformanceError("conformance failed; no claim was issued", report);
  }

  const claim = validateConformanceClaim({
    oimVersion: OIM_VERSION,
    runtime,
    profiles,
    passedCases,
  });
  return { ...report, claim };
}

function requiredCaseIds(profiles) {
  return Object.keys(profiles).flatMap((profile) => OIM_CONFORMANCE_CASES[profile]);
}

function validateProfileSelection(profiles) {
  if (!profiles || !OIM_PROFILE_VERSION_MATRIX.core.includes(profiles.core)) {
    throw new OimValidationError("profiles.core must be one of 1.0, 1.1, or 1.2");
  }
  for (const [profile, version] of Object.entries(profiles)) {
    if (profile === "core") continue;
    if (
      !(profile in OIM_PROFILE_VERSION_MATRIX) ||
      !OIM_PROFILE_VERSION_MATRIX[profile].includes(version)
    ) {
      throw new OimValidationError(`unsupported ${profile} profile version ${version}`);
    }
  }
}
