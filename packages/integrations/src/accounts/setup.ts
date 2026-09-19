import { randomUUID } from "node:crypto";
import type { McpCatalogEntry } from "@tulipfarm/mcp";
import {
  canonicalHash,
  type McpIntegrationDefinition,
  type McpSetupCredentials,
  type McpSetupEligibility,
  type McpSetupOperation,
  type McpSetupStart,
  type McpSetupStatus,
} from "@tulipfarm/schema";
import { describeMcpAccess } from "@tulipfarm/schema/mcp-access";
import { McpIntegrationError } from "../mcp/errors";
import { type McpIntegrationService, mcpServerRevision } from "../mcp/service";
import { McpAccountAccessError, type McpAccountRepository } from "./authority";
import { accountDefinitionForIntegration } from "./definition";
import { type McpAccountLifecycle, McpAccountLifecycleError } from "./lifecycle";

export interface McpSetupRepository {
  get(businessId: string, id: string): Promise<McpSetupOperation | undefined>;
  list(
    businessId: string,
    principalId: string,
    integrationKey: string,
    accountId: string
  ): Promise<McpSetupOperation[]>;
  insert(operation: McpSetupOperation): Promise<void>;
  claim(businessId: string, id: string, leaseId: string): Promise<boolean>;
  save(operation: McpSetupOperation, leaseId: string): Promise<void>;
  release(businessId: string, id: string, leaseId: string): Promise<void>;
}

export class McpSetupService<Actor> {
  constructor(
    private readonly deps: {
      operations: McpSetupRepository;
      integrations: McpIntegrationService<Actor>;
      accounts: McpAccountRepository;
      lifecycle: McpAccountLifecycle;
      catalog: readonly McpCatalogEntry[];
      isActive: (businessId: string, principalId: string) => Promise<boolean>;
      canConfigure: (businessId: string, principalId: string) => Promise<boolean>;
      audit: (operation: McpSetupOperation, action: string) => Promise<void>;
    }
  ) {}

  private async owned(businessId: string, principalId: string, id: string) {
    if (!(await this.deps.isActive(businessId, principalId)))
      throw new McpAccountAccessError("principal_inactive");
    const operation = await this.deps.operations.get(businessId, id);
    if (!operation || operation.principalId !== principalId)
      throw new McpAccountAccessError("account_not_found");
    return operation;
  }

  private summary(operation: McpSetupOperation): McpSetupStatus {
    const definition = this.deps.integrations
      .list()
      .find((entry) => entry.server.id === operation.integrationKey);
    const access = definition ? describeMcpAccess(definition) : undefined;
    if (
      definition &&
      access?.state === "initial_empty" &&
      operation.desired &&
      operation.snapshot &&
      mcpServerRevision(definition) === mcpServerRevision(operation.desired) &&
      (!this.preservesPolicy(operation.baseline) || this.hasLegacyPolicyConsent(operation)) &&
      Object.values(operation.snapshot).every((items) => items.length === 0)
    )
      access.state = "discovered_empty";
    return {
      id: operation.id,
      integrationKey: operation.integrationKey,
      ...(operation.accountId ? { accountId: operation.accountId } : {}),
      status: operation.status,
      ...(operation.error ? { error: operation.error } : {}),
      ...(access ? { access } : {}),
    };
  }

  async status(businessId: string, principalId: string, id: string): Promise<McpSetupStatus> {
    return this.summary(await this.owned(businessId, principalId, id));
  }

  private preservesPolicy(definition: McpIntegrationDefinition): boolean {
    return (
      definition.reviewPolicy !== "uninitialized" ||
      Object.values(definition.reviewed).some((items) => items.length > 0)
    );
  }

  private isLegacyEmptyPolicy(definition: McpIntegrationDefinition): boolean {
    return (
      definition.reviewPolicy === undefined &&
      Object.values(definition.reviewed).every((items) => items.length === 0)
    );
  }

  private hasLegacyPolicyConsent(operation: McpSetupOperation): boolean {
    return (
      operation.legacyEmptyPolicyConsent === "use_standard_access" &&
      operation.initializePolicy &&
      this.isLegacyEmptyPolicy(operation.baseline) &&
      operation.baseRevision === mcpServerRevision(operation.baseline)
    );
  }

  private publishedReady(definition: McpIntegrationDefinition): boolean {
    return definition.enabled && definition.reviewPolicy !== "uninitialized";
  }

  async eligibility(
    businessId: string,
    principalId: string,
    integrationKey: string
  ): Promise<McpSetupEligibility> {
    if (!(await this.deps.isActive(businessId, principalId)))
      throw new McpAccountAccessError("principal_inactive");
    const definition = this.deps.integrations.get(integrationKey);
    const canConfigure = await this.deps.canConfigure(businessId, principalId);
    return {
      definitionRevision: mcpServerRevision(definition),
      policy: this.preservesPolicy(definition) ? "preserve" : "initialize",
      publishedReady: this.publishedReady(definition),
      canConfigure,
      canUseStandardAccess: canConfigure && this.isLegacyEmptyPolicy(definition),
      access: describeMcpAccess(definition),
    };
  }

  async list(businessId: string, principalId: string, integrationKey: string, accountId: string) {
    if (!(await this.deps.isActive(businessId, principalId)))
      throw new McpAccountAccessError("principal_inactive");
    return (
      await this.deps.operations.list(businessId, principalId, integrationKey, accountId)
    ).map((operation) => this.summary(operation));
  }

  async start(
    businessId: string,
    principalId: string,
    id: string,
    input: McpSetupStart,
    actor: Actor
  ) {
    const { values: _values, clientSecret: _secret, ...intent } = input;
    const intentDigest = canonicalHash(intent);
    const existing = await this.deps.operations.get(businessId, id);
    if (existing) {
      await this.owned(businessId, principalId, id);
      if (existing.intentDigest !== intentDigest) throw new McpAccountAccessError("conflict");
      return this.resume(businessId, principalId, id, input, actor);
    }
    if (!(await this.deps.isActive(businessId, principalId)))
      throw new McpAccountAccessError("principal_inactive");
    if (!!input.providerId === !!input.integrationKey || (input.accountId && input.account)) {
      throw new McpAccountLifecycleError("invalid_credentials");
    }
    const admin = await this.deps.canConfigure(businessId, principalId);
    let baseline: McpIntegrationDefinition;
    let baseRevision: string | null;
    if (input.providerId) {
      const provider = this.deps.catalog.find((entry) => entry.id === input.providerId);
      if (
        !provider ||
        !input.authentication ||
        !provider.authentication.includes(input.authentication)
      ) {
        throw new McpAccountLifecycleError("authentication_mismatch");
      }
      const configured = this.deps.integrations
        .list()
        .find(
          ({ server }) =>
            server.transport.type === "streamable-http" && server.transport.url === provider.url
        );
      if (configured) {
        baseline = configured;
        baseRevision = mcpServerRevision(configured);
      } else {
        if (!admin) throw new McpAccountAccessError("account_access_denied");
        const key = ["github", "slack"].includes(provider.id) ? `${provider.id}-mcp` : provider.id;
        if (this.deps.integrations.list().some(({ server }) => server.id === key))
          throw new McpAccountAccessError("conflict");
        baseline = {
          server: {
            id: key,
            label: provider.name,
            transport: { type: "streamable-http" as const, url: provider.url },
            authentication: { type: input.authentication, sharedAllowed: false },
          },
          enabled: false,
          reviewed: { tools: [], resources: [], prompts: [] },
          reviewPolicy: "uninitialized" as const,
        };
        baseRevision = null;
      }
    } else {
      baseline = this.deps.integrations.get(input.integrationKey ?? "");
      baseRevision = mcpServerRevision(baseline);
    }
    if (input.definitionRevision !== undefined && input.definitionRevision !== baseRevision) {
      throw new McpAccountAccessError("definition_changed");
    }
    if (input.legacyEmptyPolicyConsent !== undefined) {
      if (!admin) throw new McpAccountAccessError("account_access_denied");
      if (input.definitionRevision !== baseRevision)
        throw new McpAccountAccessError("definition_changed");
      if (!input.initializePolicy || !this.isLegacyEmptyPolicy(baseline)) {
        throw new McpIntegrationError(
          "invalid_definition",
          "Standard access requires an empty legacy policy and explicit initial consent."
        );
      }
    }
    const authless = accountDefinitionForIntegration(baseline).authentication === "none";
    if (!authless && !input.accountId && !input.account)
      throw new McpAccountAccessError("account_required");
    if (input.account?.scope === "shared" && (!admin || !input.confirmShared)) {
      throw new McpAccountAccessError("shared_consent_required");
    }
    const operation: McpSetupOperation = {
      id,
      businessId,
      principalId,
      intentDigest,
      integrationKey: baseline.server.id,
      baseline,
      baseRevision,
      ...(input.accountId || input.account ? { accountId: input.accountId ?? randomUUID() } : {}),
      ...(input.account ? { account: input.account } : {}),
      initializePolicy: input.initializePolicy,
      ...(input.legacyEmptyPolicyConsent
        ? { legacyEmptyPolicyConsent: input.legacyEmptyPolicyConsent }
        : {}),
      confirmShared: input.confirmShared === true,
      status: "retry",
    };
    await this.deps.operations.insert(operation);
    const saved = await this.owned(businessId, principalId, id);
    if (saved.intentDigest !== intentDigest) throw new McpAccountAccessError("conflict");
    return this.resume(businessId, principalId, id, input, actor);
  }

  async resume(
    businessId: string,
    principalId: string,
    id: string,
    credentials: McpSetupCredentials,
    actor: Actor
  ): Promise<McpSetupStatus> {
    let operation = await this.owned(businessId, principalId, id);
    const lease = randomUUID();
    if (!(await this.deps.operations.claim(businessId, id, lease)))
      throw new McpAccountAccessError("conflict");
    const save = async (patch: Partial<McpSetupOperation>) => {
      operation = { ...operation, ...patch };
      await this.deps.operations.save(operation, lease);
    };
    const authorize = async () => {
      if (!(await this.deps.isActive(businessId, principalId)))
        throw new McpAccountAccessError("principal_inactive");
      await this.deps.operations.save(operation, lease);
    };
    try {
      operation = await this.owned(businessId, principalId, id);
      await authorize();
      await this.deps.audit(operation, "integration.setup.resumed");
      const admin = await this.deps.canConfigure(businessId, principalId);
      if (this.preservesPolicy(operation.baseline) && !this.hasLegacyPolicyConsent(operation)) {
        if (
          (operation.desired?.reviewPolicy === "initial" &&
            operation.baseline.reviewPolicy !== "initial") ||
          [operation.snapshot, operation.desired?.reviewed].some(
            (frozen) =>
              frozen && canonicalHash(frozen) !== canonicalHash(operation.baseline.reviewed)
          )
        ) {
          throw new McpIntegrationError(
            "capability_changed",
            "Existing capability limits must be preserved."
          );
        }
      }
      if (operation.baseRevision === null) {
        if (!admin) {
          await save({ status: "needs_admin", error: "admin_required" });
          return this.summary(operation);
        }
        await this.deps.integrations.publishSetup(operation.baseline, null, actor);
        await save({ baseRevision: mcpServerRevision(operation.baseline) });
      }
      const current = this.deps.integrations.get(operation.integrationKey);
      const targetMatches =
        operation.desired && mcpServerRevision(current) === mcpServerRevision(operation.desired);
      if (mcpServerRevision(current) !== operation.baseRevision && !targetMatches) {
        throw new McpAccountAccessError("definition_changed");
      }
      if (!admin && !this.publishedReady(current)) {
        await save({ status: "needs_admin", error: "admin_required" });
        return this.summary(operation);
      }
      const authless = accountDefinitionForIntegration(current).authentication === "none";
      if (!authless) {
        const accountId = operation.accountId;
        if (!accountId) throw new McpAccountAccessError("account_required");
        let account = await this.deps.accounts.get(businessId, accountId);
        if (!account) {
          if (!operation.account) throw new McpAccountAccessError("account_not_found");
          if (operation.account.authentication === "token" && !credentials.values) {
            await save({ status: "needs_credentials", error: "credentials_required" });
            return this.summary(operation);
          }
          if (
            operation.account.oauthClient &&
            operation.account.oauthClient.tokenEndpointAuthMethod !== "none" &&
            !credentials.clientSecret
          ) {
            await save({ status: "needs_credentials", error: "oauth_client_secret_required" });
            return this.summary(operation);
          }
          await authorize();
          await this.deps.lifecycle.create(
            businessId,
            operation.integrationKey,
            principalId,
            {
              ...operation.account,
              ...(credentials.values ? { values: credentials.values } : {}),
              ...(operation.account.oauthClient
                ? {
                    oauthClient: {
                      ...operation.account.oauthClient,
                      ...(credentials.clientSecret
                        ? { clientSecret: credentials.clientSecret }
                        : {}),
                    },
                  }
                : {}),
            },
            accountId
          );
          account = await this.deps.lifecycle.managed(
            businessId,
            operation.integrationKey,
            accountId,
            principalId
          );
        } else {
          account = await this.deps.lifecycle.managed(
            businessId,
            operation.integrationKey,
            accountId,
            principalId
          );
          if (account.owner.scope === "shared" && (!admin || !operation.confirmShared))
            throw new McpAccountAccessError("shared_consent_required");
          if (
            credentials.values &&
            account.authentication === "token" &&
            (account.status !== "active" ||
              (operation.status === "needs_credentials" &&
                operation.error === "reconnect_required") ||
              account.definitionDigest !==
                accountDefinitionForIntegration(current).definitionDigest ||
              (account.expiresAt !== null && Date.parse(account.expiresAt) <= Date.now())) &&
            !operation.snapshot
          ) {
            await this.deps.lifecycle.update(
              businessId,
              operation.integrationKey,
              accountId,
              principalId,
              { values: credentials.values }
            );
            account = await this.deps.lifecycle.managed(
              businessId,
              operation.integrationKey,
              accountId,
              principalId
            );
          }
        }
        if (account.status !== "active") {
          if (account.authentication === "oauth" && account.status !== "revoked") {
            await save({ status: "needs_sign_in", error: "sign_in_required" });
            return this.summary(operation);
          }
          if (
            account.status === "pending" &&
            account.authentication === "token" &&
            !operation.snapshot
          ) {
            await this.deps.lifecycle.verify(account, principalId);
            account = await this.deps.lifecycle.managed(
              businessId,
              operation.integrationKey,
              accountId,
              principalId
            );
          } else {
            await save({ status: "needs_credentials", error: "account_unavailable" });
            return this.summary(operation);
          }
        }
        if (
          account.definitionDigest !== accountDefinitionForIntegration(current).definitionDigest ||
          (operation.accountRevision !== undefined &&
            operation.snapshot &&
            operation.accountRevision !== account.revision)
        ) {
          throw new McpAccountAccessError("account_binding_changed");
        }
        if (account.expiresAt && Date.parse(account.expiresAt) <= Date.now()) {
          await save({
            status: account.authentication === "oauth" ? "needs_sign_in" : "needs_credentials",
            error: "account_expired",
          });
          return this.summary(operation);
        }
        await save({ accountRevision: account.revision });
      }
      const caller = {
        principal: { kind: "user", id: principalId },
        ...(operation.accountId ? { accountId: operation.accountId } : {}),
      };
      await this.deps.integrations.bind(operation.integrationKey, caller, {
        kind: "discovery",
        name: "*",
      });
      const authlessDiscovery =
        authless && !operation.snapshot
          ? await this.deps.integrations.discover(operation.integrationKey, caller)
          : undefined;
      if (!admin) {
        if (!current.enabled) {
          await save({ status: "needs_admin", error: "admin_required" });
          return this.summary(operation);
        }
        if (authlessDiscovery) await save({ snapshot: structuredClone(current.reviewed) });
      } else if (!operation.desired) {
        const hasPolicy = this.preservesPolicy(current) && !this.hasLegacyPolicyConsent(operation);
        if (!hasPolicy && !operation.initializePolicy) {
          await save({ status: "needs_admin", error: "initial_consent_required" });
          return this.summary(operation);
        }
        if (!operation.snapshot) {
          const snapshot = hasPolicy
            ? structuredClone(current.reviewed)
            : (authlessDiscovery ??
              (await this.deps.integrations.discover(operation.integrationKey, caller)));
          await save({ snapshot });
        }
        await save({
          desired: {
            ...current,
            enabled: true,
            reviewed: operation.snapshot ?? current.reviewed,
            ...(!hasPolicy
              ? { reviewPolicy: "initial" as const }
              : current.reviewPolicy === "uninitialized"
                ? { reviewPolicy: "custom" as const }
                : {}),
          },
        });
      }
      await authorize();
      await this.deps.integrations.bind(operation.integrationKey, caller, {
        kind: "discovery",
        name: "*",
      });
      if (operation.accountId) {
        const latest = await this.deps.lifecycle.managed(
          businessId,
          operation.integrationKey,
          operation.accountId,
          principalId
        );
        if (latest.status !== "active" || latest.revision !== operation.accountRevision) {
          throw new McpAccountAccessError("account_binding_changed");
        }
      }
      if (operation.desired && !targetMatches) {
        if (!(await this.deps.canConfigure(businessId, principalId))) {
          await save({ status: "needs_admin", error: "admin_required" });
          return this.summary(operation);
        }
        await this.deps.integrations.publishSetup(operation.desired, operation.baseRevision, actor);
      }
      await authorize();
      await this.deps.integrations.bind(operation.integrationKey, caller, {
        kind: "discovery",
        name: "*",
      });
      const published = this.deps.integrations.get(operation.integrationKey);
      if (
        !published.enabled ||
        (operation.desired && mcpServerRevision(published) !== mcpServerRevision(operation.desired))
      ) {
        throw new McpAccountAccessError("definition_changed");
      }
      await this.deps.audit(operation, "integration.setup.completed");
      const { error: _error, ...done } = operation;
      operation = { ...done, status: "done" };
      await this.deps.operations.save(operation, lease);
      return this.summary(operation);
    } catch (error) {
      const code =
        error instanceof McpAccountAccessError ||
        error instanceof McpAccountLifecycleError ||
        error instanceof McpIntegrationError
          ? error.code
          : "setup_failed";
      const account =
        code === "reconnect_required" && !operation.snapshot && operation.accountId
          ? await this.deps.accounts.get(businessId, operation.accountId)
          : undefined;
      const status =
        code === "probe_failed" || account?.authentication === "token"
          ? "needs_credentials"
          : account?.authentication === "oauth"
            ? "needs_sign_in"
            : "retry";
      await save({ status, error: code });
      return this.summary(operation);
    } finally {
      await this.deps.operations.release(businessId, id, lease);
    }
  }
}
