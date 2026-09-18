import type {
  McpAccount,
  McpAccountGrant,
  McpAccountSummary,
  McpChatAccountSelection,
} from "@tulipfarm/schema";

export interface McpAccountRepository {
  get(businessId: string, accountId: string): Promise<McpAccount | undefined>;
  list(businessId: string, integrationKey: string, principalId: string): Promise<McpAccount[]>;
  save(account: McpAccount, expectedRevision?: number): Promise<boolean>;
  setDefault(
    businessId: string,
    accountId: string,
    expectedRevision: number,
    isDefault: boolean
  ): Promise<boolean>;
  grants(businessId: string, accountId: string): Promise<McpAccountGrant[]>;
  saveGrant(grant: McpAccountGrant): Promise<boolean>;
  revokeGrant(
    businessId: string,
    accountId: string,
    subjectKind: McpAccountGrant["subject"]["kind"],
    subjectId: string
  ): Promise<void>;
  selection(
    businessId: string,
    conversationId: string,
    principalId: string,
    integrationKey: string
  ): Promise<McpChatAccountSelection | undefined>;
  saveSelection(selection: McpChatAccountSelection, replace?: boolean): Promise<boolean>;
}

export interface McpAccountAuthorization {
  isActivePrincipal(businessId: string, principalId: string): Promise<boolean>;
  isTeamMember(businessId: string, teamId: string, principalId: string): Promise<boolean>;
  canManageShared(businessId: string, principalId: string): Promise<boolean>;
}

export interface McpAccountBinding {
  readonly accountId: string;
  readonly accountRevision: number;
  readonly definitionDigest: string;
}

export interface McpAccountScope {
  readonly businessId: string;
  readonly integrationKey: string;
  readonly definitionDigest: string;
}

export interface McpChatAccountContext extends McpAccountScope {
  readonly kind: "chat";
  readonly conversationId: string;
  readonly principalId: string;
  readonly visibility: "private" | "shared";
  readonly pinned?: McpAccountBinding;
}

export interface McpInteractiveAccountContext extends McpAccountScope {
  readonly kind: "interactive";
  readonly principalId: string;
  readonly accountId?: string;
  readonly purpose: "discovery" | "content";
}

interface McpBackgroundAccountContext extends McpAccountScope {
  readonly ownerPrincipalId: string;
  readonly visibility: "owner" | "shared";
  readonly accountId: string;
  readonly accountRevision: number;
  readonly configurationDigest: string;
}

/** Host-derived authority from durable Chat/Run state, never from model-supplied Tool arguments. */
export type McpAccountUseContext =
  | McpChatAccountContext
  | McpInteractiveAccountContext
  | (McpBackgroundAccountContext & { readonly kind: "routine"; readonly routineId: string })
  | (McpBackgroundAccountContext & { readonly kind: "knowledge_sync"; readonly syncId: string });

export type McpAccountAccessErrorCode =
  | "account_required"
  | "account_selection_required"
  | "account_not_found"
  | "account_unavailable"
  | "account_expired"
  | "account_access_denied"
  | "private_context_required"
  | "shared_consent_required"
  | "routine_approval_required"
  | "knowledge_approval_required"
  | "account_binding_changed"
  | "definition_changed"
  | "principal_inactive"
  | "conflict";

export class McpAccountAccessError extends Error {
  constructor(readonly code: McpAccountAccessErrorCode) {
    super(code);
    this.name = "McpAccountAccessError";
  }
}

export function summarizeMcpAccount(account: McpAccount): McpAccountSummary {
  return {
    id: account.id,
    businessId: account.businessId,
    integrationKey: account.integrationKey,
    definitionDigest: account.definitionDigest,
    label: account.label,
    owner: account.owner,
    status: account.status,
    authentication: account.authentication,
    ...(account.oauthClient ? { oauthClient: { ...account.oauthClient } } : {}),
    isDefault: account.isDefault,
    revision: account.revision,
    expiresAt: account.expiresAt,
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
  };
}

export class McpAccountAuthority {
  constructor(
    private readonly accounts: McpAccountRepository,
    private readonly authorization: McpAccountAuthorization,
    private readonly now: () => Date = () => new Date()
  ) {}

  async list(
    businessId: string,
    integrationKey: string,
    principalId: string
  ): Promise<McpAccountSummary[]> {
    await this.assertPrincipal(businessId, principalId);
    const canManageShared = await this.authorization.canManageShared(businessId, principalId);
    const visible: McpAccountSummary[] = [];
    for (const account of await this.accounts.list(businessId, integrationKey, principalId)) {
      if (
        (account.owner.scope === "personal" && account.owner.principalId === principalId) ||
        (account.owner.scope === "shared" &&
          (canManageShared || (await this.hasChatGrant(account, principalId))))
      ) {
        visible.push(summarizeMcpAccount(account));
      }
    }
    return visible;
  }

  async assertManage(account: McpAccount, principalId: string): Promise<void> {
    await this.assertPrincipal(account.businessId, principalId);
    const allowed =
      account.owner.scope === "personal"
        ? account.owner.principalId === principalId
        : await this.authorization.canManageShared(account.businessId, principalId);
    if (!allowed) throw new McpAccountAccessError("account_access_denied");
  }

  async selectChatAccount(
    context: McpChatAccountContext,
    accountId: string,
    confirmShared: boolean
  ): Promise<McpAccountSummary> {
    await this.assertPrincipal(context.businessId, context.principalId);
    const account = await this.requireAccount(context, accountId);
    await this.assertChatUse(account, context, confirmShared);
    await this.pinChat(context, account, confirmShared);
    return summarizeMcpAccount(account);
  }

  async resolve(context: McpAccountUseContext): Promise<McpAccount> {
    return this.resolveAccount(context, false);
  }

  async resolveForRefresh(context: McpAccountUseContext): Promise<McpAccount> {
    const account = await this.resolveAccount(context, true);
    if (account.authentication !== "oauth") {
      throw new McpAccountAccessError("account_access_denied");
    }
    return account;
  }

  private async resolveAccount(
    context: McpAccountUseContext,
    allowExpiredOAuth: boolean
  ): Promise<McpAccount> {
    if (context.kind === "interactive") {
      return this.resolveInteractive(context, allowExpiredOAuth);
    }
    if (context.kind !== "chat") return this.resolveBackground(context, allowExpiredOAuth);
    await this.assertPrincipal(context.businessId, context.principalId);
    const selection = await this.accounts.selection(
      context.businessId,
      context.conversationId,
      context.principalId,
      context.integrationKey
    );
    if (selection) {
      const account = await this.requireAccount(context, selection.accountId, allowExpiredOAuth);
      this.assertBinding(account, selection);
      if (context.pinned) this.assertBinding(account, context.pinned);
      await this.assertChatUse(account, context, selection.sharedConsent);
      return account;
    }
    if (context.pinned) throw new McpAccountAccessError("account_binding_changed");
    const personal = (
      await this.accounts.list(context.businessId, context.integrationKey, context.principalId)
    ).filter(
      (account) =>
        account.owner.scope === "personal" && account.owner.principalId === context.principalId
    );
    if (personal.length === 0) throw new McpAccountAccessError("account_required");
    const defaults = personal.filter((account) => account.isDefault);
    const account =
      defaults.length === 1 ? defaults[0] : personal.length === 1 ? personal[0] : undefined;
    if (!account) throw new McpAccountAccessError("account_selection_required");
    this.assertCurrent(account, context, allowExpiredOAuth);
    await this.assertChatUse(account, context, false);
    await this.pinChat(context, account, false, false);
    return account;
  }

  private async resolveBackground(
    context: Extract<McpAccountUseContext, { kind: "routine" | "knowledge_sync" }>,
    allowExpiredOAuth: boolean
  ): Promise<McpAccount> {
    const account = await this.requireAccount(context, context.accountId, allowExpiredOAuth);
    this.assertBinding(account, context);
    await this.assertPrincipal(context.businessId, context.ownerPrincipalId);
    if (account.owner.scope === "personal") {
      if (account.owner.principalId !== context.ownerPrincipalId) {
        throw new McpAccountAccessError("account_access_denied");
      }
      if (context.visibility !== "owner") {
        throw new McpAccountAccessError("private_context_required");
      }
      return account;
    }

    const subjectId = context.kind === "routine" ? context.routineId : context.syncId;
    const grants = await this.accounts.grants(context.businessId, account.id);
    const approved = grants.some(
      (grant) =>
        grant.accountRevision === account.revision &&
        grant.subject.kind === context.kind &&
        grant.subject.id === subjectId &&
        "configurationDigest" in grant.subject &&
        grant.subject.configurationDigest === context.configurationDigest
    );
    if (!approved) {
      throw new McpAccountAccessError(
        context.kind === "routine" ? "routine_approval_required" : "knowledge_approval_required"
      );
    }
    return account;
  }

  private async resolveInteractive(
    context: McpInteractiveAccountContext,
    allowExpiredOAuth: boolean
  ): Promise<McpAccount> {
    await this.assertPrincipal(context.businessId, context.principalId);
    let account: McpAccount;
    if (context.accountId) {
      account = await this.requireAccount(context, context.accountId, allowExpiredOAuth);
    } else {
      const personal = (
        await this.accounts.list(context.businessId, context.integrationKey, context.principalId)
      ).filter(
        (candidate) =>
          candidate.owner.scope === "personal" &&
          candidate.owner.principalId === context.principalId
      );
      if (personal.length === 0) throw new McpAccountAccessError("account_required");
      const defaults = personal.filter((candidate) => candidate.isDefault);
      const selected =
        defaults.length === 1 ? defaults[0] : personal.length === 1 ? personal[0] : undefined;
      if (!selected) throw new McpAccountAccessError("account_selection_required");
      account = selected;
      this.assertCurrent(account, context, allowExpiredOAuth);
    }
    if (account.owner.scope === "personal") {
      if (account.owner.principalId !== context.principalId) {
        throw new McpAccountAccessError("account_access_denied");
      }
    } else {
      if (context.purpose !== "discovery" || !context.accountId) {
        throw new McpAccountAccessError("shared_consent_required");
      }
      await this.assertManage(account, context.principalId);
    }
    return account;
  }

  private async assertChatUse(
    account: McpAccount,
    context: McpChatAccountContext,
    sharedConsent: boolean
  ): Promise<void> {
    if (account.owner.scope === "personal") {
      if (account.owner.principalId !== context.principalId) {
        throw new McpAccountAccessError("account_access_denied");
      }
      if (context.visibility !== "private") {
        throw new McpAccountAccessError("private_context_required");
      }
      return;
    }
    if (!(await this.hasChatGrant(account, context.principalId))) {
      throw new McpAccountAccessError("account_access_denied");
    }
    if (!sharedConsent) throw new McpAccountAccessError("shared_consent_required");
  }

  private async hasChatGrant(account: McpAccount, principalId: string): Promise<boolean> {
    for (const grant of await this.accounts.grants(account.businessId, account.id)) {
      if (grant.accountRevision !== account.revision) continue;
      if (grant.subject.kind === "user" && grant.subject.id === principalId) return true;
      if (
        grant.subject.kind === "team" &&
        (await this.authorization.isTeamMember(account.businessId, grant.subject.id, principalId))
      ) {
        return true;
      }
    }
    return false;
  }

  private async requireAccount(
    scope: McpAccountScope,
    accountId: string,
    allowExpiredOAuth = false
  ): Promise<McpAccount> {
    const account = await this.accounts.get(scope.businessId, accountId);
    if (
      !account ||
      account.businessId !== scope.businessId ||
      account.integrationKey !== scope.integrationKey
    ) {
      throw new McpAccountAccessError("account_not_found");
    }
    this.assertCurrent(account, scope, allowExpiredOAuth);
    return account;
  }

  private assertCurrent(
    account: McpAccount,
    scope: McpAccountScope,
    allowExpiredOAuth = false
  ): void {
    if (account.definitionDigest !== scope.definitionDigest) {
      throw new McpAccountAccessError("definition_changed");
    }
    if (account.status !== "active") throw new McpAccountAccessError("account_unavailable");
    if (
      account.expiresAt !== null &&
      Date.parse(account.expiresAt) <= this.now().getTime() &&
      !(allowExpiredOAuth && account.authentication === "oauth")
    ) {
      throw new McpAccountAccessError("account_expired");
    }
  }

  private assertBinding(account: McpAccount, binding: McpAccountBinding): void {
    if (
      account.id !== binding.accountId ||
      account.revision !== binding.accountRevision ||
      account.definitionDigest !== binding.definitionDigest
    ) {
      throw new McpAccountAccessError("account_binding_changed");
    }
  }

  private async assertPrincipal(businessId: string, principalId: string): Promise<void> {
    if (!(await this.authorization.isActivePrincipal(businessId, principalId))) {
      throw new McpAccountAccessError("principal_inactive");
    }
  }

  private async pinChat(
    context: McpChatAccountContext,
    account: McpAccount,
    sharedConsent: boolean,
    replace = true
  ): Promise<void> {
    const saved = await this.accounts.saveSelection(
      {
        businessId: context.businessId,
        conversationId: context.conversationId,
        principalId: context.principalId,
        integrationKey: context.integrationKey,
        accountId: account.id,
        accountRevision: account.revision,
        definitionDigest: account.definitionDigest,
        sharedConsent,
        selectedAt: this.now().toISOString(),
      },
      replace
    );
    if (!saved) throw new McpAccountAccessError("conflict");
  }
}
