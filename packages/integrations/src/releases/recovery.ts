export interface QuarantinedOimRelease {
  readonly businessId: string;
  readonly integrationId: string;
  readonly majorVersion: number;
  readonly version: string;
  readonly packageDigest: string;
  readonly source: string;
}

export interface RecoverQuarantinedOimReleaseRequest {
  readonly businessId: string;
  readonly integrationId: string;
  readonly majorVersion: number;
  readonly source: string;
  readonly sourceRef: string;
  readonly candidatePath: string;
  readonly slug: string;
}

export interface VerifiedOimReleaseLocation {
  readonly integrationId: string;
  readonly version: string;
  readonly majorVersion: number;
  readonly packageDigest: string;
}

export interface VerifiedOimSoulReleaseLocation extends VerifiedOimReleaseLocation {
  readonly soulRevision: string;
}

export interface OimReleaseRecoveryDeps {
  readonly provenance: {
    findQuarantined(
      businessId: string,
      integrationId: string,
      majorVersion: number
    ): Promise<QuarantinedOimRelease | null>;
    recover(input: RecoverQuarantinedOimReleaseRequest & VerifiedOimSoulReleaseLocation): Promise<{
      readonly installationId: string;
    }>;
  };
  readonly inspectSource: (
    source: string,
    sourceRef: string,
    candidatePath: string
  ) => Promise<VerifiedOimReleaseLocation & { readonly resolvedRef: string }>;
  readonly inspectSoulArtifact: (slug: string) => Promise<VerifiedOimSoulReleaseLocation | null>;
}

function sameRelease(expected: QuarantinedOimRelease, actual: VerifiedOimReleaseLocation): boolean {
  return (
    expected.integrationId === actual.integrationId &&
    expected.version === actual.version &&
    expected.majorVersion === actual.majorVersion &&
    expected.packageDigest === actual.packageDigest
  );
}

export async function recoverQuarantinedOimRelease(
  input: RecoverQuarantinedOimReleaseRequest,
  deps: OimReleaseRecoveryDeps
): Promise<{ readonly installationId: string }> {
  const quarantined = await deps.provenance.findQuarantined(
    input.businessId,
    input.integrationId,
    input.majorVersion
  );
  if (quarantined === null) throw new Error("oim_release_quarantine_missing");
  if (quarantined.source !== input.source) throw new Error("oim_release_recovery_source_mismatch");

  const [source, soul] = await Promise.all([
    deps.inspectSource(input.source, input.sourceRef, input.candidatePath),
    deps.inspectSoulArtifact(input.slug),
  ]);
  if (
    source.resolvedRef !== input.sourceRef ||
    !sameRelease(quarantined, source) ||
    soul === null ||
    !sameRelease(quarantined, soul)
  ) {
    throw new Error("oim_release_recovery_verification_failed");
  }

  return deps.provenance.recover({
    ...input,
    version: quarantined.version,
    packageDigest: quarantined.packageDigest,
    soulRevision: soul.soulRevision,
  });
}
