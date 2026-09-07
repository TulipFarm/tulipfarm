import type { FileService } from "@tulipfarm/files";
import type { OimFilePort } from "@tulipfarm/integrations";

/** Connects OIM's byte-only port to the File service's single validation and ACL path. */
export function oimFiles(files: FileService): OimFilePort {
  return {
    content: async ({ businessId, fileId, principalId }) =>
      await files.content(businessId, fileId, principalId),
    store: async ({
      businessId,
      ownerPrincipalId,
      filename,
      claimedMediaType,
      declaredBytes,
      body,
    }) =>
      await files.upload({
        businessId,
        ownerPrincipalId,
        filename,
        claimedMediaType,
        declaredBytes,
        body,
      }),
  };
}
