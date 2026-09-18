import { randomUUID } from "node:crypto";
import { SecretBroker } from "./broker";
import type { SecretsService } from "./encrypted-store";
import { SecretLeaseDeniedError, SecretLeaseSet } from "./lease";
import { secretsServiceProvider } from "./providers";
import { secretStorageKey } from "./secret-reference";

export interface McpSecretScope {
  readonly businessId: string;
  readonly accountId: string;
  readonly accountRevision: number;
  readonly definitionDigest: string;
  readonly principalId: string;
  readonly destination: string;
  readonly purpose: string;
  readonly runId?: string;
  readonly stateId?: string;
  readonly toolId?: string;
}

/** Account references never name environment variables or use the legacy plaintext cache. */
export class McpAccountSecrets {
  constructor(private readonly secrets: SecretsService) {}

  async write(values: Readonly<Record<string, string>>): Promise<Record<string, string>> {
    const bindings: Record<string, string> = {};
    try {
      for (const [slot, value] of Object.entries(values)) {
        const key = randomUUID();
        bindings[slot] = `secret://${key}`;
        await this.secrets.set(key, value);
      }
      return bindings;
    } catch (error) {
      await this.remove(bindings);
      throw error;
    }
  }

  async remove(bindings: Readonly<Record<string, string>>): Promise<void> {
    for (const reference of new Set(Object.values(bindings))) {
      await this.secrets.delete(secretStorageKey(reference));
    }
  }

  async use<T>(
    bindings: Readonly<Record<string, string>>,
    scope: McpSecretScope,
    authorize: () => Promise<void>,
    callback: (values: Readonly<Record<string, string>>) => Promise<T>
  ): Promise<T> {
    const selectedBindings = Object.freeze({ ...bindings });
    const selectedScope = Object.freeze({ ...scope });
    const runId = selectedScope.runId ?? randomUUID();
    await authorize();
    if (Object.keys(selectedBindings).length === 0) return callback({});
    const provider = secretsServiceProvider(this.secrets);
    const versions = new Map<string, string>();
    for (const reference of Object.values(selectedBindings)) {
      const revision = await this.secrets.revision(secretStorageKey(reference));
      if (revision === null) throw new SecretLeaseDeniedError("revoked", "Account Secret revoked");
      versions.set(reference, revision);
    }
    const broker = new SecretBroker({
      provider: {
        async resolveCurrent(reference) {
          const resolved = await provider.resolveUncached?.(reference);
          if (!resolved || resolved.version !== versions.get(reference)) return null;
          return resolved;
        },
      },
      authorizer: {
        async authorize(lease) {
          await authorize();
          const revision = await provider.currentVersion?.(lease.secretRef);
          return { allowed: revision === versions.get(lease.secretRef) };
        },
      },
    });
    try {
      const leases: Record<string, Awaited<ReturnType<SecretBroker["lease"]>>> = {};
      for (const [slot, secretRef] of Object.entries(selectedBindings)) {
        leases[slot] = await broker.lease({
          scope: {
            secretRef,
            toolId: selectedScope.toolId ?? `mcp:${selectedScope.purpose}`,
            integrationId: selectedScope.definitionDigest,
            targetId: JSON.stringify([
              selectedScope.businessId,
              selectedScope.accountId,
              selectedScope.accountRevision,
              slot,
            ]),
            runId,
            ...(selectedScope.stateId === undefined ? {} : { stateId: selectedScope.stateId }),
            principalKind: "user",
            principalId: selectedScope.principalId,
            destination: selectedScope.destination,
            purpose: selectedScope.purpose,
          },
          maxUses: 1,
          ttlMs: 60_000,
        });
      }
      return await new SecretLeaseSet(leases).use(callback);
    } finally {
      broker.revokeAll();
    }
  }
}
