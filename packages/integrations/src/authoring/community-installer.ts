import type {
  InstalledOimRelease,
  InstallReviewedCommunityOimReleaseDeps,
  InstallReviewedCommunityOimReleaseInput,
} from "../releases";
import type { IntegrationAuthoringResult, ReviewedCommunityIntegrationInstaller } from "./workflow";

type InstallReviewedCommunityOimRelease = (
  input: InstallReviewedCommunityOimReleaseInput,
  dependencies: InstallReviewedCommunityOimReleaseDeps
) => Promise<InstalledOimRelease>;

export interface ReviewedCommunityIntegrationInstallerDependencies {
  readonly installReviewedCommunityOimRelease: InstallReviewedCommunityOimRelease;
  readonly releaseDependencies: InstallReviewedCommunityOimReleaseDeps;
}

function codedError(error: unknown): { readonly name?: string; readonly code?: string } {
  if (typeof error !== "object" || error === null) return {};
  const candidate = error as { readonly name?: unknown; readonly code?: unknown };
  return {
    ...(typeof candidate.name === "string" ? { name: candidate.name } : {}),
    ...(typeof candidate.code === "string" ? { code: candidate.code } : {}),
  };
}

function installError(error: unknown): IntegrationAuthoringResult {
  const { name, code } = codedError(error);
  if (
    code === "REPLACE_PRECONDITION_MISMATCH" ||
    code === "REVIEWED_COMMUNITY_REPLACEMENT_INVALID"
  ) {
    return {
      success: false,
      error: {
        code: "validation_error",
        message: "The installed Integration changed. Review the package again.",
      },
    };
  }
  if (code === "REVIEWED_COMMUNITY_DRAFT_UNAVAILABLE") {
    return {
      success: false,
      error: {
        code: "validation_error",
        message: "The reviewed Integration draft is unavailable. Review it again.",
      },
    };
  }
  if (code === "INVALID_RELEASE_VERSION" || code === "COMMUNITY_HOOKS_FORBIDDEN") {
    return {
      success: false,
      error: {
        code: "validation_error",
        message: "The reviewed Integration package is not eligible for Community installation.",
      },
    };
  }
  if (
    name === "OimPackageVerificationError" ||
    code === "COMMUNITY_DIGEST_REQUIRED" ||
    code === "INVALID_AUTHORED_RELEASE_SOURCE" ||
    code === "INVALID_AUTHORED_RELEASE_ACTOR" ||
    code === "INSTALL_ROLLBACK_FAILED"
  ) {
    return {
      success: false,
      error: {
        code: "internal_error",
        message: "The reviewed Integration package failed its durable install integrity check.",
      },
    };
  }
  if (
    code === "COMMUNITY_OFFICIAL_RELEASE" ||
    code === "COMMUNITY_SIGNATURE_DOWNGRADE" ||
    code === "OFFICIAL_RELEASE_REVOKED" ||
    name === "OimReleaseTrustError"
  ) {
    return {
      success: false,
      error: {
        code: "write_denied",
        message: "The reviewed Integration package cannot be installed as a Community release.",
      },
    };
  }
  if (name === "OimReleaseInstallError") {
    return {
      success: false,
      error: {
        code: "internal_error",
        message: "The reviewed Integration package failed its durable install integrity check.",
      },
    };
  }
  return {
    success: false,
    error: {
      code: "unavailable",
      message: "Community Integration installation is temporarily unavailable.",
    },
  };
}

export function createReviewedCommunityIntegrationInstaller(
  dependencies: ReviewedCommunityIntegrationInstallerDependencies
): ReviewedCommunityIntegrationInstaller {
  return {
    install: async (input) => {
      try {
        const installed = await dependencies.installReviewedCommunityOimRelease(
          {
            businessId: input.businessId,
            slug: input.slug,
            approvedPackageDigest: input.packageDigest,
            principal: input.principal,
            runId: input.runId,
            replace: input.replace,
          },
          dependencies.releaseDependencies
        );
        return {
          success: true,
          data: {
            slug: input.slug,
            installed: true,
            ...installed,
          },
        };
      } catch (error) {
        return installError(error);
      }
    },
  };
}
