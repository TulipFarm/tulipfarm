import { McpAccountAccessError, type McpAccountAuthority } from "@tulipfarm/integrations";
import { secretStorageKey } from "@tulipfarm/secrets";
import type { McpAccountStore } from "@tulipfarm/storage";
import type { RequestPrincipal } from "../../identity/principal";

export interface IntegrationSecretMetadata {
  key: string;
  label: string;
  accountId?: string;
  accountLabel: string;
  accountCreatedAt?: string;
  scope: "personal" | "shared";
  field: string;
}

export function createIntegrationSecretMetadata(deps: {
  accounts: Pick<McpAccountStore, "findBySecretKeys">;
  authority: Pick<McpAccountAuthority, "assertManage">;
  integrationLabel: (key: string) => string;
}) {
  return async (
    keys: readonly string[],
    principal: RequestPrincipal
  ): Promise<ReadonlyMap<string, IntegrationSecretMetadata | null>> => {
    const metadata = new Map<string, IntegrationSecretMetadata | null>();
    const requested = new Set(keys);
    for (const account of await deps.accounts.findBySecretKeys(keys)) {
      let visible = principal.kind === "user" && account.businessId === principal.businessId;
      if (visible) {
        try {
          await deps.authority.assertManage(account, principal.id);
        } catch (error) {
          if (
            !(error instanceof McpAccountAccessError) ||
            !["account_access_denied", "principal_inactive"].includes(error.code)
          ) {
            throw error;
          }
          visible = false;
        }
      }
      for (const [field, reference] of Object.entries(account.secretBindings)) {
        const key = secretStorageKey(reference);
        if (!requested.has(key) || metadata.get(key) === null) continue;
        metadata.set(
          key,
          visible
            ? {
                key: account.integrationKey,
                label: deps.integrationLabel(account.integrationKey),
                accountId: account.id,
                accountLabel: account.label,
                accountCreatedAt: account.createdAt,
                scope: account.owner.scope,
                field,
              }
            : null
        );
      }
    }
    return metadata;
  };
}
