import type { AuditService } from "../../audit/service";
import type { McpAccountFeatureDeps } from "./compose";

export function createMcpAccountAudit(
  audit: Pick<AuditService, "record">
): McpAccountFeatureDeps["audit"] {
  return async (event) => {
    await audit.record({
      actorId: event.principalId,
      action: event.action,
      target: `integration-account:${event.accountId}`,
      reasonCodes: event.code ? [event.code] : [],
      safeMetadata: {
        ...(event.revision === undefined ? {} : { accountRevision: event.revision }),
        ...(event.subject === undefined ? {} : { subject: event.subject }),
      },
    });
  };
}
