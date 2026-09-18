import { randomUUID } from "node:crypto";
import type { McpAccount, McpAccountCreate, McpAccountSummary } from "@tulipfarm/schema";
import {
  McpAccountAccessError,
  type McpAccountAuthority,
  type McpAccountRepository,
  summarizeMcpAccount,
} from "./authority";

export interface McpAccountDefinition {
  readonly integrationKey: string;
  readonly definitionDigest: string;
  readonly authentication: McpAccount["authentication"];
  readonly requiredSlots: readonly string[];
  readonly sharedAllowed: boolean;
}

export interface McpAccountVault {
  write(values: Readonly<Record<string, string>>): Promise<Record<string, string>>;
  remove(bindings: Readonly<Record<string, string>>): Promise<void>;
}

export interface McpAccountLifecycleDeps {
  readonly accounts: McpAccountRepository;
  readonly authority: McpAccountAuthority;
  readonly secrets: McpAccountVault;
  readonly definition: (integrationKey: string) => Promise<McpAccountDefinition>;
  readonly probe: (
    account: McpAccount,
    authorize: () => Promise<void>,
    principalId: string
  ) => Promise<void>;
  readonly audit: (event: {
    readonly action: string;
    readonly accountId: string;
    readonly businessId: string;
    readonly principalId: string;
    readonly revision: number;
  }) => Promise<void>;
  readonly now?: () => Date;
}

export class McpAccountLifecycleError extends Error {
  constructor(
    readonly code:
      | "invalid_credentials"
      | "unsupported_account_mode"
      | "authentication_mismatch"
      | "probe_failed"
      | "oauth_required"
      | "default_requires_active_account"
  ) {
    super(code);
    this.name = "McpAccountLifecycleError";
  }
}

export interface McpAccountUpdate {
  readonly label?: string;
  readonly isDefault?: boolean;
  readonly values?: Readonly<Record<string, string>>;
}

export class McpAccountLifecycle {
  constructor(private readonly deps: McpAccountLifecycleDeps) {}

  async create(
    businessId: string,
    integrationKey: string,
    principalId: string,
    input: McpAccountCreate
  ): Promise<McpAccountSummary> {
    const definition = await this.deps.definition(integrationKey);
    if (definition.authentication !== input.authentication) {
      throw new McpAccountLifecycleError("authentication_mismatch");
    }
    if (input.authentication === "oauth" && input.isDefault) {
      throw new McpAccountLifecycleError("default_requires_active_account");
    }
    if (input.scope === "shared" && !definition.sharedAllowed) {
      throw new McpAccountLifecycleError("unsupported_account_mode");
    }
    if (
      input.oauthClient &&
      (input.authentication !== "oauth" ||
        (input.oauthClient.tokenEndpointAuthMethod === "none"
          ? input.oauthClient.clientSecret !== undefined
          : !input.oauthClient.clientSecret))
    ) {
      throw new McpAccountLifecycleError("invalid_credentials");
    }
    const at = this.now();
    const account: McpAccount = {
      id: randomUUID(),
      businessId,
      integrationKey,
      definitionDigest: definition.definitionDigest,
      label: input.label,
      owner: input.scope === "personal" ? { scope: "personal", principalId } : { scope: "shared" },
      status: "pending",
      authentication: input.authentication,
      ...(input.oauthClient
        ? {
            oauthClient: {
              clientId: input.oauthClient.clientId,
              tokenEndpointAuthMethod: input.oauthClient.tokenEndpointAuthMethod,
            },
          }
        : {}),
      isDefault: false,
      revision: 1,
      secretBindings: {},
      expiresAt: null,
      createdAt: at,
      updatedAt: at,
    };
    await this.deps.authority.assertManage(account, principalId);
    this.validateValues(definition, input.values ?? {});
    account.secretBindings = await this.deps.secrets.write({
      ...input.values,
      ...(input.oauthClient?.clientSecret
        ? { oauthClientSecret: input.oauthClient.clientSecret }
        : {}),
    });
    if (!(await this.deps.accounts.save(account))) {
      await this.deps.secrets.remove(account.secretBindings);
      throw new McpAccountAccessError("conflict");
    }
    await this.record("integration.account.created", account, principalId);
    if (account.authentication === "oauth") return summarizeMcpAccount(account);
    return this.verify(account, principalId, input.isDefault ?? false);
  }

  async update(
    businessId: string,
    integrationKey: string,
    accountId: string,
    principalId: string,
    input: McpAccountUpdate
  ): Promise<McpAccountSummary> {
    const account = await this.managed(businessId, integrationKey, accountId, principalId);
    if (account.status === "revoked") throw new McpAccountAccessError("account_unavailable");
    const definition = await this.deps.definition(integrationKey);
    if (definition.authentication !== account.authentication) {
      throw new McpAccountLifecycleError("authentication_mismatch");
    }
    if (account.owner.scope === "shared" && !definition.sharedAllowed) {
      throw new McpAccountLifecycleError("unsupported_account_mode");
    }
    if (input.values === undefined) {
      if (definition.definitionDigest !== account.definitionDigest) {
        throw new McpAccountAccessError("definition_changed");
      }
      if (input.label !== undefined) {
        const renamed = { ...account, label: input.label, updatedAt: this.now() };
        if (!(await this.deps.accounts.save(renamed, account.revision))) {
          throw new McpAccountAccessError("conflict");
        }
        account.label = input.label;
      }
      if (input.isDefault !== undefined) {
        if (
          !(await this.deps.accounts.setDefault(
            businessId,
            accountId,
            account.revision,
            input.isDefault
          ))
        ) {
          throw new McpAccountAccessError("conflict");
        }
        account.isDefault = input.isDefault;
      }
      await this.record("integration.account.updated", account, principalId);
      return summarizeMcpAccount(account);
    }
    if (account.authentication === "oauth") throw new McpAccountLifecycleError("oauth_required");
    this.validateValues(definition, input.values);
    const bindings = await this.deps.secrets.write(input.values);
    const replacement: McpAccount = {
      ...account,
      label: input.label ?? account.label,
      definitionDigest: definition.definitionDigest,
      revision: account.revision + 1,
      status: "pending",
      isDefault: false,
      expiresAt: null,
      secretBindings: bindings,
      updatedAt: this.now(),
    };
    if (!(await this.deps.accounts.save(replacement, account.revision))) {
      await this.deps.secrets.remove(bindings);
      throw new McpAccountAccessError("conflict");
    }
    await this.deps.secrets.remove(account.secretBindings);
    await this.record("integration.account.credentials_replaced", replacement, principalId);
    return this.verify(replacement, principalId, input.isDefault ?? account.isDefault);
  }

  async revoke(
    businessId: string,
    integrationKey: string,
    accountId: string,
    principalId: string
  ): Promise<McpAccountSummary> {
    const account = await this.managed(businessId, integrationKey, accountId, principalId);
    const revoked: McpAccount = {
      ...account,
      status: "revoked",
      revision: account.revision + 1,
      isDefault: false,
      secretBindings: {},
      expiresAt: null,
      updatedAt: this.now(),
    };
    if (!(await this.deps.accounts.save(revoked, account.revision))) {
      throw new McpAccountAccessError("conflict");
    }
    await this.record("integration.account.revoked", revoked, principalId);
    await this.deps.secrets.remove(account.secretBindings);
    return summarizeMcpAccount(revoked);
  }

  async managed(
    businessId: string,
    integrationKey: string,
    accountId: string,
    principalId: string
  ): Promise<McpAccount> {
    const account = await this.deps.accounts.get(businessId, accountId);
    if (!account || account.integrationKey !== integrationKey) {
      throw new McpAccountAccessError("account_not_found");
    }
    await this.deps.authority.assertManage(account, principalId);
    return account;
  }

  async verify(
    account: McpAccount,
    principalId: string,
    isDefault = false
  ): Promise<McpAccountSummary> {
    const authorize = async () => {
      const current = await this.managed(
        account.businessId,
        account.integrationKey,
        account.id,
        principalId
      );
      const definition = await this.deps.definition(account.integrationKey);
      if (
        current.revision !== account.revision ||
        current.status !== "pending" ||
        current.definitionDigest !== account.definitionDigest ||
        definition.definitionDigest !== account.definitionDigest
      ) {
        throw new McpAccountAccessError("account_binding_changed");
      }
    };
    try {
      await authorize();
      await this.deps.probe(account, authorize, principalId);
      await authorize();
    } catch (error) {
      if (
        !(await this.deps.accounts.save(
          { ...account, status: "action_required", updatedAt: this.now() },
          account.revision
        ))
      ) {
        throw new McpAccountAccessError("conflict");
      }
      await this.record("integration.account.probe_failed", account, principalId);
      if (error instanceof McpAccountAccessError) throw error;
      throw new McpAccountLifecycleError("probe_failed");
    }
    const active: McpAccount = { ...account, status: "active", updatedAt: this.now() };
    if (!(await this.deps.accounts.save(active, account.revision))) {
      throw new McpAccountAccessError("conflict");
    }
    if (isDefault) {
      if (
        !(await this.deps.accounts.setDefault(active.businessId, active.id, active.revision, true))
      ) {
        throw new McpAccountAccessError("conflict");
      }
      active.isDefault = true;
    }
    await this.record("integration.account.connected", active, principalId);
    return summarizeMcpAccount(active);
  }

  private validateValues(
    definition: McpAccountDefinition,
    values: Readonly<Record<string, string>>
  ): void {
    const slots = definition.authentication === "token" ? definition.requiredSlots : [];
    if (
      (definition.authentication === "token" && slots.length === 0) ||
      Object.keys(values).length !== slots.length ||
      slots.some((slot) => !Object.hasOwn(values, slot) || !values[slot])
    ) {
      throw new McpAccountLifecycleError("invalid_credentials");
    }
  }

  private now(): string {
    return (this.deps.now?.() ?? new Date()).toISOString();
  }

  private record(action: string, account: McpAccount, principalId: string): Promise<void> {
    return this.deps.audit({
      action,
      accountId: account.id,
      businessId: account.businessId,
      principalId,
      revision: account.revision,
    });
  }
}
