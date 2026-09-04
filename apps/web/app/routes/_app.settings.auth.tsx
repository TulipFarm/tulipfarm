import { type FormEvent, useEffect, useState } from "react";
import { FormStatus } from "~/components/form-status";
import { Trash2 } from "~/components/icons";
import { Button } from "~/components/ui/button";
import { CopyField } from "~/components/ui/copy-field";
import { Field } from "~/components/ui/field";
import { Input } from "~/components/ui/input";
import { Panel, PanelEmpty, PanelRow } from "~/components/ui/panel";
import { ApiError, changePassword } from "~/lib/api";
import { type ApiToken, createApiToken, listApiTokens, revokeApiToken } from "~/lib/settings";

function messageOf(err: unknown): string {
  return err instanceof ApiError ? err.message : "Could not reach the API.";
}

export default function AuthSettings() {
  return (
    <div className="space-y-6">
      <PasswordPanel />
      <TokensPanel />
    </div>
  );
}

/**
 * The current password is required by the API — possession of a session is not enough to replace
 * the credential behind it.
 */
function PasswordPanel() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const mismatch = confirm.length > 0 && next !== confirm;
  const ready = current.length > 0 && next.length > 0 && confirm.length > 0 && !mismatch;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setDone(false);
    setBusy(true);
    try {
      // Only the confirm match is checked client-side. The API owns every password rule and its
      // message is what gets rendered, so restating the length here would be a second source to drift.
      await changePassword(current, next);
      setCurrent("");
      setNext("");
      setConfirm("");
      setDone(true);
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel
      title="Password"
      description="Changing it keeps this session signed in and leaves your other sessions alone."
      footer={
        <>
          <span className="text-xs text-muted-foreground">
            Your current password is required to set a new one.
          </span>
          <Button type="submit" form="password-form" size="sm" disabled={busy || !ready}>
            {busy ? "Saving…" : "Change password"}
          </Button>
        </>
      }
    >
      <form id="password-form" onSubmit={onSubmit} className="max-w-sm space-y-4">
        {error ? <FormStatus tone="error">{error}</FormStatus> : null}
        {done ? <FormStatus tone="success">Password updated.</FormStatus> : null}

        <Field label="Current password">
          <Input
            type="password"
            autoComplete="current-password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
          />
        </Field>
        <Field label="New password">
          <Input
            type="password"
            autoComplete="new-password"
            value={next}
            onChange={(e) => setNext(e.target.value)}
          />
        </Field>
        <Field label="Confirm new password" error={mismatch ? "These do not match." : undefined}>
          <Input
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
          />
        </Field>
      </form>
    </Panel>
  );
}

/**
 * Personal access tokens. The backend has supported these since the auth module landed and nothing
 * in the product ever called them, so this is the first surface for a capability that already exists.
 */
function TokensPanel() {
  const [tokens, setTokens] = useState<ApiToken[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [issued, setIssued] = useState<{ name: string; token: string } | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);

  useEffect(() => {
    listApiTokens()
      .then(setTokens)
      .catch((err) => {
        setError(messageOf(err));
        setTokens([]);
      });
  }, []);

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    setError(null);
    setBusy(true);
    try {
      const { token, ...meta } = await createApiToken(trimmed);
      setIssued({ name: meta.name, token });
      setTokens((prev) => [meta, ...(prev ?? [])]);
      setName("");
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  }

  async function onRevoke(token: ApiToken) {
    setError(null);
    setRevoking(token.id);
    try {
      await revokeApiToken(token.id);
      setTokens((prev) => (prev ?? []).filter((t) => t.id !== token.id));
      setIssued((prev) => (prev?.name === token.name ? null : prev));
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setRevoking(null);
    }
  }

  return (
    <Panel
      title="API tokens"
      description="For scripts and integrations that act as you. A token carries your full access. Revoke one the moment it is no longer needed."
    >
      <div className="space-y-4">
        {error ? <FormStatus tone="error">{error}</FormStatus> : null}

        {issued ? (
          <div className="space-y-2 rounded-md border border-primary/40 bg-primary/5 p-3">
            <p className="text-sm font-medium text-foreground">Copy “{issued.name}” now</p>
            <p className="text-xs text-muted-foreground">
              This is the only time the full token is shown. If you lose it, revoke this one and
              create another.
            </p>
            <CopyField value={issued.token} label={`API token ${issued.name}`} />
          </div>
        ) : null}

        <form onSubmit={onCreate} className="flex items-end gap-2">
          <Field label="New token name" className="flex-1" help="Name it after where it will run.">
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. nightly-invoice-sync"
            />
          </Field>
          <Button type="submit" variant="outline" size="sm" disabled={busy || !name.trim()}>
            {busy ? "Creating…" : "Create"}
          </Button>
        </form>

        <div className="overflow-hidden rounded-md border border-border">
          {tokens === null ? (
            <PanelEmpty>Loading…</PanelEmpty>
          ) : tokens.length === 0 ? (
            <PanelEmpty>No tokens yet.</PanelEmpty>
          ) : (
            tokens.map((token) => (
              <PanelRow key={token.id}>
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-foreground">{token.name}</p>
                  <p className="text-xs text-muted-foreground">
                    <span className="font-mono">{token.prefix}…</span> · created{" "}
                    {new Date(token.createdAt).toLocaleDateString()}
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  className="shrink-0 text-destructive hover:bg-destructive/10 hover:text-destructive"
                  onClick={() => onRevoke(token)}
                  disabled={revoking === token.id}
                  aria-label={`Revoke ${token.name}`}
                >
                  <Trash2 className="size-4" />
                  {revoking === token.id ? "Revoking…" : "Revoke"}
                </Button>
              </PanelRow>
            ))
          )}
        </div>
      </div>
    </Panel>
  );
}
