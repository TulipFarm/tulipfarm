import { type OimReleaseCandidate, selectOimReleaseCandidate } from "./candidates";
import {
  type InstallCommunityOimReleaseInput,
  type InstalledOimRelease,
  type InstallOfficialOimReleaseInput,
  type InstallSelectedOimReleaseDeps,
  installSelectedOimRelease,
} from "./installer";

type SourceInstallEvidence = {
  readonly actorId: string;
};

export type InstallOimReleaseFromSourceInput =
  | (Omit<InstallOfficialOimReleaseInput, "candidatePath" | "candidates" | "sourceRef"> &
      SourceInstallEvidence)
  | (Omit<InstallCommunityOimReleaseInput, "candidatePath" | "candidates" | "sourceRef"> &
      SourceInstallEvidence);

export interface OimReleaseSourceCandidate extends OimReleaseCandidate {
  readonly sourcePath: string;
}

export interface OimReleaseSourceInspection {
  readonly ref: string;
  readonly candidates: readonly OimReleaseSourceCandidate[];
}

export interface InstallOimReleaseFromSourceDeps extends InstallSelectedOimReleaseDeps {
  readonly inspectSource: (source: string, actorId: string) => Promise<OimReleaseSourceInspection>;
  readonly lifecycle: {
    /**
     * Serializes install, patch, and uninstall for this exact major across processes, and refuses
     * installation while an uninstall journal is pending.
     */
    runInstallExclusive<T>(
      scope: {
        readonly businessId: string;
        readonly integrationId: string;
        readonly majorVersion: number;
        readonly slug: string;
      },
      operation: () => Promise<T>
    ): Promise<T>;
  };
}

export async function installOimReleaseFromSource(
  input: InstallOimReleaseFromSourceInput,
  deps: InstallOimReleaseFromSourceDeps
): Promise<InstalledOimRelease & { readonly sourceRef: string; readonly candidatePath: string }> {
  const inspection = await deps.inspectSource(input.source, input.actorId);
  const selected = selectOimReleaseCandidate(input.selection, inspection.candidates);
  const selectedSource = inspection.candidates.find((candidate) => candidate === selected);
  if (selectedSource === undefined) throw new Error("oim_release_candidate_source_missing");
  const majorVersion = Number(input.selection.version.split(".")[0]);
  if (!Number.isSafeInteger(majorVersion) || majorVersion < 0) {
    throw new Error("invalid_oim_release_major");
  }
  const installed = await deps.lifecycle.runInstallExclusive(
    {
      businessId: input.businessId,
      integrationId: input.selection.integrationId,
      majorVersion,
      slug: input.slug,
    },
    () =>
      installSelectedOimRelease(
        {
          ...input,
          sourceRef: inspection.ref,
          candidatePath: selectedSource.sourcePath,
          candidates: inspection.candidates,
        },
        deps
      )
  );
  return Object.freeze({
    ...installed,
    sourceRef: inspection.ref,
    candidatePath: selectedSource.sourcePath,
  });
}
