import { cloneElement, type ReactElement, type ReactNode, useId } from "react";
import { ApiError } from "~/lib/api";

export function mcpError(error: unknown): string {
  if (error instanceof ApiError && error.code) {
    const explanations: Record<string, string> = {
      account_required:
        "Connect a personal account or explicitly choose an authorized shared account.",
      selection_required: "Choose an exact account in a private Chat before continuing.",
      consent_required: "Confirm the shared account in a private Chat before continuing.",
      reconnect_required: "Reconnect this exact account before continuing.",
      review_required: "An admin needs to review and allow this feature before you can use it.",
      disabled: "This integration is disabled. Ask an admin to enable it.",
      unavailable:
        "This integration cannot run here yet. Ask your admin to check its hosting setup.",
      native_installation_not_active:
        "Reconnect this provider workspace or GitHub App installation.",
      native_destination_invalid:
        "Check the exact provider channel, repository and thread identifiers.",
      native_agent_access_denied: "Every selected user must have permission to use this Agent.",
      native_routine_binding_invalid: "Check the exact provider account, event and destination.",
      native_routine_authority_unavailable:
        "Routine account authorization is unavailable. Try again after the runtime is configured.",
      native_routine_not_published:
        "Publish this Routine and approve its shared account use before enabling the event.",
      account_selection_required: "Choose the exact account to use for this Chat.",
      account_not_found: "This account is no longer available.",
      account_unavailable:
        "This account needs repair. Reconnect it or explicitly choose another account.",
      account_expired: "This account has expired. Sign in again or replace its token.",
      account_access_denied: "You no longer have permission to use this account.",
      private_context_required:
        "Personal accounts can only be used privately. Continue in a private Chat.",
      shared_consent_required: "Confirm the shared account before using it in this Chat.",
      routine_approval_required: "An admin must approve this Routine's current configuration.",
      knowledge_approval_required: "Knowledge sync needs a separate current approval.",
      account_binding_changed: "This account changed. Review and select it again.",
      definition_changed:
        "The integration settings changed. Add a new account for the new settings; the old account's credentials cannot be reused.",
      principal_inactive: "Your account is inactive. Ask an administrator for access.",
      invalid_credentials: "Provide all required credential fields.",
      unsupported_account_mode:
        "This integration does not support shared accounts. Connect your personal account.",
      authentication_mismatch: "This sign-in method does not match the integration settings.",
      probe_failed:
        "We could not verify this account with the provider. Check its sign-in details and try again.",
      oauth_required: "Use browser sign-in to connect this account.",
      oauth_failed: "Provider authorization did not complete. Start browser sign-in again.",
      default_requires_active_account: "Connect this account before making it the default.",
      oauth_invalid_state:
        "This sign-in attempt expired or was already used. Start browser sign-in again.",
      oauth_issuer_mismatch:
        "The sign-in response came from a different provider. Start browser sign-in again.",
      oauth_refresh_busy: "This account is being refreshed. Wait a moment and try again.",
    };
    if (explanations[error.code]) return explanations[error.code];
  }
  if (
    error instanceof ApiError &&
    error.status === 409 &&
    (!error.code || ["conflict", "revision_conflict", "capability_changed"].includes(error.code))
  ) {
    return "This Integration changed while you were editing. Reload its current settings and try again.";
  }
  return error instanceof Error ? error.message : "The request failed. Please try again.";
}

export function McpError({ error }: { error: unknown }) {
  if (!error) return null;
  return (
    <p
      role="alert"
      className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
    >
      {mcpError(error)}
      {error instanceof ApiError && error.path ? (
        <span className="mt-1 block text-xs">Field: {error.path}</span>
      ) : null}
    </p>
  );
}

export function McpSection({ title, children }: { title: string; children: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="space-y-3 border-t border-border pt-5">
      <h3 id={id} className="text-sm font-semibold">
        {title}
      </h3>
      {children}
    </section>
  );
}

export function McpField({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactElement<{ id?: string }>;
  hint?: string;
}) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1.5 text-sm">
      <label htmlFor={id} className="font-medium">
        {label}
      </label>
      {cloneElement(children, { id })}
      {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
    </div>
  );
}

export function checkedValues(
  values: readonly string[],
  value: string,
  checked: boolean
): string[] {
  return checked ? [...new Set([...values, value])] : values.filter((item) => item !== value);
}
