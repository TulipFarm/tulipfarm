import { oimPackageDigest } from "@tulipfarm/schema";
import type { OimReleasePackage } from "./package-verifier";
import {
  type TrustedOimPublicKey,
  type VerifiedSignedOimRelease,
  verifySignedOimRelease,
} from "./signatures";

export interface OimReleaseSelection {
  readonly integrationId: string;
  readonly version: string;
  readonly packageDigest: string;
}

export interface OimReleaseCandidate {
  readonly package: OimReleasePackage;
  readonly signedRelease?: unknown;
  readonly sourceIssues?: readonly string[];
}

export type OimReleaseCandidateErrorCode =
  | "RELEASE_CANDIDATE_AMBIGUOUS"
  | "RELEASE_CANDIDATE_INVALID"
  | "RELEASE_CANDIDATE_NOT_FOUND";

export class OimReleaseCandidateError extends Error {
  constructor(
    readonly code: OimReleaseCandidateErrorCode,
    message: string
  ) {
    super(message);
    this.name = "OimReleaseCandidateError";
  }
}

function matchesSelection(candidate: OimReleaseCandidate, selection: OimReleaseSelection): boolean {
  return (
    candidate.package.manifest.metadata.id === selection.integrationId &&
    candidate.package.manifest.metadata.version === selection.version &&
    oimPackageDigest(candidate.package.manifest) === selection.packageDigest
  );
}

export function selectOimReleaseCandidate(
  selection: OimReleaseSelection,
  candidates: readonly OimReleaseCandidate[]
): OimReleaseCandidate {
  const matches = candidates.filter((candidate) => matchesSelection(candidate, selection));
  if (matches.length === 0) {
    throw new OimReleaseCandidateError(
      "RELEASE_CANDIDATE_NOT_FOUND",
      "No inspected OIM release candidate matches the selected package"
    );
  }
  if (matches.length !== 1) {
    throw new OimReleaseCandidateError(
      "RELEASE_CANDIDATE_AMBIGUOUS",
      "More than one inspected OIM release candidate matches the selected package"
    );
  }
  const candidate = matches[0];
  if (candidate === undefined) {
    throw new OimReleaseCandidateError(
      "RELEASE_CANDIDATE_NOT_FOUND",
      "No inspected OIM release candidate matches the selected package"
    );
  }
  if ((candidate.sourceIssues?.length ?? 0) > 0) {
    throw new OimReleaseCandidateError(
      "RELEASE_CANDIDATE_INVALID",
      `Selected OIM release candidate is unsafe: ${candidate.sourceIssues?.join("; ")}`
    );
  }
  return candidate;
}

export function verifySelectedOimReleaseCandidate(
  selection: OimReleaseSelection,
  candidates: readonly OimReleaseCandidate[],
  trustedKeys: readonly TrustedOimPublicKey[]
): VerifiedSignedOimRelease {
  const candidate = selectOimReleaseCandidate(selection, candidates);
  return verifySignedOimRelease(candidate.package, candidate.signedRelease, trustedKeys);
}
