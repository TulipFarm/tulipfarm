import type {
  McpAccountCreate,
  McpAccountSummary,
  McpIntegrationDefinition,
} from "@tulipfarm/schema";
import { describeMcpAccess } from "@tulipfarm/schema/mcp-access";
import { useEffect, useRef, useState } from "react";
import { StatusBadge } from "~/components/status-badge";
import { Button } from "~/components/ui/button";
import { Link } from "~/components/ui/link";
import { ApiError } from "~/lib/api";
import { type McpAccountConfiguration, startMcpAccountOAuth } from "~/lib/mcp-accounts";
import { configureMcpIntegration, removeMcpIntegration } from "~/lib/mcp-integrations";
import { type McpSetupEligibility, type McpSetupStart, setupAccountInput } from "~/lib/mcp-setup";
import { IntegrationChoice } from "./integration-choice";
import { mcpAccessMessage } from "./mcp-access-message";
import { McpAccountForm } from "./mcp-account-form";
import { McpAccountRow } from "./mcp-account-row";
import { accountLabel, accountName } from "./mcp-account-selection";
import { McpAdvancedAccess } from "./mcp-advanced-access";
import { McpError, McpField, McpSection } from "./mcp-form";
import { INITIAL_SETUP_CONSENT } from "./mcp-provider-setup";
import { McpServerForm } from "./mcp-server-form";
import { McpSetupProgress } from "./mcp-setup-progress";
import { useMcpSetup } from "./use-mcp-setup";

const STANDARD_ACCESS_CONSENT =
  "Replace the old empty access policy with currently available Tools and content. Every Tool call requires approval; future additions stay off.";

export function McpServerDetail({
  definition,
  accounts,
  accountsError,
  callbackStatus,
  callbackError,
  accountConfiguration,
  configurationError,
  eligibility,
  eligibilityError,
  refreshing = false,
  callbackAccountId,
  onChanged,
  onRemoved,
  onDone,
  embedded = false,
}: {
  definition: McpIntegrationDefinition;
  accounts: McpAccountSummary[];
  accountsError?: string;
  callbackStatus?: string;
  callbackError?: string;
  accountConfiguration?: McpAccountConfiguration;
  configurationError?: string;
  eligibility?: McpSetupEligibility;
  eligibilityError?: string;
  refreshing?: boolean;
  callbackAccountId?: string;
  onChanged: () => void;
  onRemoved: () => void;
  onDone?: () => void;
  embedded?: boolean;
}) {
  const isAdmin = eligibility?.canConfigure === true;
  const [selectedId, setSelectedId] = useState(callbackAccountId ?? "");
  const [adding, setAdding] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>();
  const lastConsent = useRef<boolean | undefined>(undefined);
  const metadataReady =
    !!accountConfiguration &&
    !!eligibility &&
    !eligibilityError &&
    !accountsError &&
    !configurationError &&
    !refreshing;
  const authless = accountConfiguration?.authentication === "none";
  const candidates = accounts.filter(
    (account) =>
      account.status !== "revoked" &&
      (account.owner.scope === "personal" || isAdmin) &&
      account.authentication === accountConfiguration?.authentication &&
      (account.authentication !== "oauth" ||
        !accountConfiguration?.definitionDigest ||
        account.definitionDigest === accountConfiguration?.definitionDigest)
  );
  const solePersonalId =
    metadataReady && candidates.length === 1 && candidates[0]?.owner.scope === "personal"
      ? candidates[0].id
      : undefined;
  useEffect(() => {
    if (!selectedId && !callbackAccountId && solePersonalId) setSelectedId(solePersonalId);
  }, [selectedId, solePersonalId, callbackAccountId]);
  const selected = candidates.find((account) => account.id === selectedId);
  const setup = useMcpSetup(onChanged, {
    integrationKey: definition.server.id,
    accountId: metadataReady && !adding ? selected?.id : undefined,
  });
  const currentAccount =
    selected?.status === "active" &&
    (!accountConfiguration?.definitionDigest ||
      selected.definitionDigest === accountConfiguration.definitionDigest) &&
    (!selected.expiresAt || Date.parse(selected.expiresAt) > Date.now());
  const hasReviewedAccess = Object.values(definition.reviewed).some((items) => items.length > 0);
  const connected = metadataReady && eligibility.publishedReady && (authless || currentAccount);
  const ready = connected && hasReviewedAccess;
  const initializePolicy = isAdmin && eligibility?.policy === "initialize";
  const canUseStandardAccess = metadataReady && isAdmin && eligibility.canUseStandardAccess;
  const working = setup.pending || setup.operation || setup.uncertain;
  const stalePreview =
    !setup.operation &&
    !setup.uncertain &&
    setup.error instanceof ApiError &&
    setup.error.code === "definition_changed";
  const consent = !initializePolicy
    ? eligibility?.policy === "preserve" && !hasReviewedAccess
      ? "Existing settings allow no Tools or content. Connecting preserves those restrictions; change access explicitly in Advanced settings."
      : "Your integration's existing access restrictions and action approvals stay unchanged. New or changed capabilities are not added."
    : INITIAL_SETUP_CONSENT;
  const showAccountManagement =
    metadataReady &&
    eligibility.publishedReady &&
    !adding &&
    !setup.restoring &&
    !setup.restoreError &&
    !setup.pending &&
    !setup.uncertain &&
    (!setup.operation || setup.operation.status === "done");
  const managedAccounts = showAccountManagement
    ? selected
      ? [selected]
      : selectedId
        ? []
        : candidates
    : [];
  const advancedAccounts = accounts.filter(
    (account) => !managedAccounts.some((managed) => managed.id === account.id)
  );
  const accountChoiceLabel = eligibility?.publishedReady
    ? "Account to manage"
    : "Account to connect";
  const existingLabels = new Set(accounts.map((account) => account.label));
  const baseAccountLabel = `${definition.server.label} account`.slice(0, 128);
  let newAccountLabel = baseAccountLabel;
  for (let suffix = 2; existingLabels.has(newAccountLabel); suffix += 1) {
    const ending = ` ${suffix}`;
    newAccountLabel = `${baseAccountLabel.slice(0, 128 - ending.length)}${ending}`;
  }

  function setupInput(standard: boolean): McpSetupStart {
    if (!eligibility || (standard && !canUseStandardAccess))
      throw new Error("Setup permissions changed. Reload current settings before connecting.");
    return {
      integrationKey: definition.server.id,
      definitionRevision: eligibility.definitionRevision,
      initializePolicy: standard || initializePolicy,
      ...(standard ? { legacyEmptyPolicyConsent: "use_standard_access" as const } : {}),
    };
  }

  function startSetup(input: McpSetupStart, standard: boolean) {
    if (lastConsent.current !== undefined && lastConsent.current !== standard) setup.reset();
    lastConsent.current = standard;
    setAdvanced(false);
    return setup.start(input);
  }

  async function connectAccount(input: McpAccountCreate, standard = false) {
    const saved = await startSetup(
      {
        ...setupInput(standard),
        ...setupAccountInput(input),
      },
      standard
    );
    if (saved?.accountId) {
      setSelectedId(saved.accountId);
      setAdding(false);
    }
    if (
      saved?.status === "needs_sign_in" &&
      saved.accountId &&
      input.authentication === "oauth" &&
      !input.oauthClient
    )
      await startMcpAccountOAuth(saved.integrationKey, saved.accountId);
  }

  async function finishConnecting(standard = false) {
    try {
      await startSetup(
        {
          ...setupInput(standard),
          ...(selected ? { accountId: selected.id } : {}),
          ...(selected?.owner.scope === "shared" ? { confirmShared: true } : {}),
        },
        standard
      );
    } catch (cause) {
      setError(cause);
    }
  }

  function connectAnother() {
    setup.reset();
    setError(undefined);
    setAdding(true);
  }

  async function disable() {
    setPending(true);
    setError(undefined);
    try {
      await configureMcpIntegration(definition.server.id, {
        server: definition.server,
        enabled: false,
      });
      setup.reset();
      onChanged();
    } catch (cause) {
      setError(cause);
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="max-w-3xl space-y-5">
      {!embedded && (
        <>
          <Link to="/integrations" className="text-sm text-brand hover:underline">
            Back to Integrations
          </Link>
          <header className="space-y-1">
            <h2 className="text-lg font-semibold">{definition.server.label}</h2>
            <p className="text-xs text-muted-foreground">
              Connect your account. Keep access settings optional.
            </p>
          </header>
        </>
      )}
      <McpError error={error} />
      <McpError error={callbackError ? new Error(callbackError) : undefined} />
      {callbackStatus && (
        <p role="status" className="text-xs text-muted-foreground">
          {callbackStatus}
        </p>
      )}
      {accountsError && (
        <div className="space-y-2">
          <McpError error={new Error(accountsError)} />
          <Button variant="outline" onClick={onChanged}>
            Retry accounts
          </Button>
        </div>
      )}
      {!accountConfiguration && (
        <div className="space-y-2">
          <McpError
            error={
              new Error(
                configurationError ??
                  "Account setup is not available. An admin must finish this integration's sign-in settings."
              )
            }
          />
          <Button variant="outline" onClick={onChanged}>
            Reload account setup
          </Button>
        </div>
      )}
      {eligibilityError && (
        <div className="space-y-2">
          <McpError error={new Error(eligibilityError)} />
          <Button variant="outline" onClick={onChanged}>
            Reload setup permissions
          </Button>
        </div>
      )}
      {refreshing || (!eligibility && !eligibilityError) ? (
        <p role="status" className="text-xs text-muted-foreground">
          Checking setup permissions...
        </p>
      ) : !eligibility || eligibilityError ? null : stalePreview ? (
        <div className="space-y-3">
          <McpError
            error={
              new Error(
                "Integration settings changed before setup started. Reload the current settings before connecting."
              )
            }
          />
          <Button
            onClick={() => {
              setup.reset();
              onChanged();
            }}
          >
            Reload setup permissions
          </Button>
        </div>
      ) : !isAdmin && !eligibility.publishedReady ? (
        <div className="space-y-3">
          <h3 className="text-sm font-semibold">An admin needs to finish setup</h3>
          <p className="text-xs text-muted-foreground">
            An admin must publish approved access before you can connect your personal account.
          </p>
          <Button variant="outline" onClick={onChanged}>
            Check setup status
          </Button>
        </div>
      ) : working ? (
        <McpSetupProgress
          setup={setup}
          configuration={accountConfiguration}
          account={accounts.find((account) => account.id === setup.operation?.accountId)}
          publishedReady={eligibility.publishedReady}
          standardAccess={
            canUseStandardAccess &&
            setup.operation?.status === "done" &&
            (authless || (currentAccount && selected?.id === setup.operation.accountId))
              ? {
                  consent: STANDARD_ACCESS_CONSENT,
                  connect: () => {
                    setup.reset();
                    void finishConnecting(true);
                  },
                }
              : undefined
          }
          oauthReturned={
            !!callbackStatus &&
            callbackAccountId === setup.operation?.accountId &&
            !setup.resumeAttempted
          }
          onDone={onDone}
          onRestart={() => {
            setup.reset();
            onChanged();
          }}
        />
      ) : setup.restoring ? (
        <p role="status" className="text-xs text-muted-foreground">
          Checking saved setup...
        </p>
      ) : setup.restoreError ? (
        <div className="space-y-3">
          <McpError error={setup.restoreError} />
          <Button variant="outline" onClick={setup.retryRestore}>
            Retry saved setup
          </Button>
        </div>
      ) : metadataReady ? (
        <section aria-label="Connect integration" className="space-y-4">
          <McpError error={setup.error} />
          {!adding && selected && !showAccountManagement && (
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-sm font-medium">{accountName(selected, candidates)}</p>
                <p className="text-xs text-muted-foreground">
                  {selected.owner.scope === "personal"
                    ? "Personal · only you"
                    : "Shared · access managed by admins"}
                </p>
              </div>
              <StatusBadge
                label={currentAccount ? "Account connected" : "Account needs attention"}
                tone={currentAccount ? "success" : "warning"}
              />
            </div>
          )}
          {!adding &&
            candidates.length > 0 &&
            (!solePersonalId || selected?.id !== solePersonalId) && (
              <McpField label={accountChoiceLabel}>
                <IntegrationChoice
                  label={accountChoiceLabel}
                  value={selected?.id ?? ""}
                  options={candidates.map((account) => ({
                    value: account.id,
                    label: accountLabel(account, candidates),
                  }))}
                  onChange={(id) => {
                    setup.reset();
                    setSelectedId(id);
                  }}
                />
              </McpField>
            )}
          {!adding && selectedId && !selected && (
            <p role="alert" className="text-sm text-destructive">
              The selected account is no longer available. Choose an account explicitly or connect
              your own.
            </p>
          )}
          {!adding && !selectedId && showAccountManagement && candidates.length > 1 ? (
            <div className="space-y-2">
              <h3 className="text-sm font-semibold">Manage your accounts</h3>
              <p className="text-xs text-muted-foreground">
                Choose the account whose token you want to replace, or manage it below. Existing
                Chats keep their selected account.
              </p>
            </div>
          ) : !adding && connected ? (
            <>
              <p role="status" className="text-sm font-semibold">
                {ready
                  ? "Ready to use"
                  : authless
                    ? "No access allowed"
                    : "Account connected — no access allowed"}
              </p>
              <p className="text-xs text-muted-foreground">
                {hasReviewedAccess
                  ? authless
                    ? "Use this integration in Chat. Its existing access restrictions and action approvals still apply."
                    : "Choose this account in Chat. Its existing access restrictions and action approvals still apply."
                  : mcpAccessMessage(describeMcpAccess(definition))}
              </p>
              {ready ? (
                <Button asChild>
                  <Link to="/">Open Chat</Link>
                </Button>
              ) : canUseStandardAccess ? (
                <div className="space-y-2">
                  <p className="text-xs text-muted-foreground">{STANDARD_ACCESS_CONSENT}</p>
                  <Button onClick={() => void finishConnecting(true)}>
                    Use standard access and connect
                  </Button>
                </div>
              ) : isAdmin ? (
                <>
                  <p className="text-xs text-muted-foreground">
                    Standard access cannot replace this saved policy. Review and explicitly save any
                    changes.
                  </p>
                  <Button onClick={() => setAdvanced(true)}>Edit allowed access</Button>
                </>
              ) : (
                <p className="text-xs text-muted-foreground">
                  Ask an admin to review allowed access.
                </p>
              )}
            </>
          ) : !authless && (adding || candidates.length === 0) ? (
            <div className="space-y-3">
              <h3 className="text-sm font-semibold">Connect your account</h3>
              {adding && (
                <p className="text-sm text-muted-foreground">
                  Adding another account creates a separate connection. It does not replace an
                  existing token or switch any Chat to the new account.
                </p>
              )}
              <McpAccountForm
                key={`${definition.server.id}:${accountConfiguration.authentication}:${adding}`}
                integrationKey={definition.server.id}
                defaultLabel={newAccountLabel}
                {...accountConfiguration}
                sharedAllowed={isAdmin && accountConfiguration.sharedAllowed}
                consent={consent}
                connect={(input) => connectAccount(input)}
                standardAccess={
                  canUseStandardAccess
                    ? {
                        consent: STANDARD_ACCESS_CONSENT,
                        connect: (input) => connectAccount(input, true),
                      }
                    : undefined
                }
                onFailure={setError}
                onChanged={onChanged}
              />
              {adding && (
                <Button variant="ghost" onClick={() => setAdding(false)}>
                  Cancel
                </Button>
              )}
            </div>
          ) : (
            <div className="space-y-3">
              <h3 className="text-sm font-semibold">Finish connecting</h3>
              <p className="text-xs text-muted-foreground">{consent}</p>
              {selected?.owner.scope === "shared" && (
                <p className="text-xs text-muted-foreground">
                  Finish setup with this exact shared account. This does not grant anyone access or
                  consent to shared Chat use.
                </p>
              )}
              <Button
                variant={canUseStandardAccess ? "outline" : "default"}
                disabled={!authless && !selected}
                onClick={() => void finishConnecting()}
              >
                {canUseStandardAccess ? "Keep existing access and connect" : "Finish connecting"}
              </Button>
              {canUseStandardAccess && (
                <div className="space-y-2">
                  <p className="text-xs text-muted-foreground">{STANDARD_ACCESS_CONSENT}</p>
                  <Button
                    disabled={!authless && !selected}
                    onClick={() => void finishConnecting(true)}
                  >
                    Use standard access and connect
                  </Button>
                </div>
              )}
            </div>
          )}
        </section>
      ) : null}
      {managedAccounts.length > 0 && (
        <McpSection title={managedAccounts.length === 1 ? "Manage account" : "Accounts"}>
          <ul className="divide-y divide-border">
            {managedAccounts.map((account) => (
              <McpAccountRow
                key={`${account.id}:${account.revision}`}
                account={account}
                accounts={candidates}
                requiredSlots={accountConfiguration?.requiredSlots}
                definitionDigest={accountConfiguration?.definitionDigest}
                definitionAuthentication={accountConfiguration?.authentication}
                onChanged={() => {
                  setup.reset();
                  onChanged();
                }}
                onError={setError}
              />
            ))}
          </ul>
        </McpSection>
      )}
      {!authless &&
        metadataReady &&
        (isAdmin || eligibility.publishedReady) &&
        !setup.restoring &&
        !setup.restoreError &&
        accounts.length > 0 &&
        !adding &&
        !setup.pending &&
        (!working || setup.operation?.status === "done") && (
          <Button variant="ghost" size="sm" onClick={connectAnother}>
            Add another account
          </Button>
        )}
      <details
        open={advanced}
        onToggle={(event) => setAdvanced(event.currentTarget.open)}
        className="space-y-5 border-t border-border pt-4"
      >
        <summary className="cursor-pointer text-xs text-muted-foreground">
          Advanced settings
        </summary>
        {advanced && (
          <>
            {metadataReady && (
              <McpAdvancedAccess
                canConfigure={isAdmin}
                definition={definition}
                accounts={accounts}
                configuration={accountConfiguration}
                onChanged={onChanged}
              />
            )}
            {advancedAccounts.length > 0 && !accountsError && (
              <McpSection title={managedAccounts.length > 0 ? "Other accounts" : "Accounts"}>
                <ul className="divide-y divide-border">
                  {advancedAccounts.map((account) => (
                    <McpAccountRow
                      key={`${account.id}:${account.revision}`}
                      account={account}
                      accounts={accounts}
                      primary={false}
                      requiredSlots={accountConfiguration?.requiredSlots}
                      definitionDigest={accountConfiguration?.definitionDigest}
                      definitionAuthentication={accountConfiguration?.authentication}
                      onChanged={onChanged}
                      onError={setError}
                    />
                  ))}
                </ul>
              </McpSection>
            )}
            <McpSection title="Integration settings">
              {editing ? (
                <McpServerForm
                  supportedAuthentication={accountConfiguration?.supportedAuthentication}
                  initial={definition}
                  onSaved={() => {
                    setEditing(false);
                    onChanged();
                  }}
                  onCancel={() => setEditing(false)}
                />
              ) : (
                <div className="flex flex-wrap gap-2">
                  {isAdmin && (
                    <Button variant="outline" onClick={() => setEditing(true)}>
                      Edit settings
                    </Button>
                  )}
                  {isAdmin && definition.enabled && (
                    <Button variant="outline" disabled={pending} onClick={() => void disable()}>
                      Disable integration
                    </Button>
                  )}
                </div>
              )}
              <details className="space-y-2 text-xs text-muted-foreground">
                <summary className="cursor-pointer">Technical details</summary>
                <p>
                  Integration ID: <code>{definition.server.id}</code>
                </p>
                <p className="break-all">
                  {definition.server.transport.type === "streamable-http"
                    ? definition.server.transport.url
                    : `${definition.server.transport.image} · ${definition.server.transport.command}`}
                </p>
                {definition.server.transport.type === "stdio" && (
                  <p>
                    Production requires operator-configured Kata VM isolation on supported
                    Linux/KVM. There is no ordinary-container fallback.
                  </p>
                )}
              </details>
            </McpSection>
            {isAdmin && (
              <McpSection title="Remove integration">
                <p className="text-xs text-muted-foreground">
                  Removal stops this integration's Tools and content. It does not undo completed
                  external actions.
                </p>
                {confirming ? (
                  <div className="flex gap-2">
                    <Button
                      variant="destructive"
                      disabled={pending}
                      onClick={async () => {
                        setPending(true);
                        setError(undefined);
                        try {
                          await removeMcpIntegration(definition.server.id);
                          onRemoved();
                        } catch (cause) {
                          setError(cause);
                        } finally {
                          setPending(false);
                        }
                      }}
                    >
                      {pending ? "Removing..." : "Confirm remove integration"}
                    </Button>
                    <Button
                      variant="outline"
                      disabled={pending}
                      onClick={() => setConfirming(false)}
                    >
                      Cancel
                    </Button>
                  </div>
                ) : (
                  <Button variant="outline" onClick={() => setConfirming(true)}>
                    Remove integration
                  </Button>
                )}
              </McpSection>
            )}
          </>
        )}
      </details>
    </div>
  );
}
