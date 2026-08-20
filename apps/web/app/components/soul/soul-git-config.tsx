import { GitBranch } from "lucide-react";
import { type FormEvent, useState } from "react";
import { StatusBadge, type StatusTone } from "~/components/status-badge";
import { Button } from "~/components/ui/button";
import { Field } from "~/components/ui/field";
import { Input } from "~/components/ui/input";
import { ApiError } from "~/lib/api";
import { friendlyGitError, putGitConfig, type SoulGitConfig, syncSoul } from "~/lib/soul";
import { useIsAdmin } from "~/lib/use-session-user";

function errorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 403) return "Only an admin can change the git remote.";
    return friendlyGitError(err.message);
  }
  return err instanceof Error ? friendlyGitError(err.message) : "request failed";
}

/**
 * Every state below is one `GET /api/v1/soul/git-config` can actually report: `remoteConfigured`,
 * `lastSyncError`, and the `ahead`/`behind` counts `GitSync.getStatus()` derives from
 * `rev-list --left-right`. Nothing here is inferred.
 */
function statusLabel(status: SoulGitConfig["status"]): {
  text: string;
  tone: StatusTone;
} {
  if (!status.remoteConfigured) {
    return { text: "Not connected", tone: "neutral" };
  }
  if (status.lastSyncError) {
    return { text: "Sync failed", tone: "danger" };
  }
  if (status.ahead === 0 && status.behind === 0) {
    return { text: "Up to date", tone: "success" };
  }
  const parts: string[] = [];
  if (status.ahead > 0) parts.push(`${status.ahead} ahead`);
  if (status.behind > 0) parts.push(`${status.behind} behind`);
  return { text: parts.join(", "), tone: "warning" };
}

function formatLastSync(iso: string | null): string {
  if (!iso) return "never synced";
  return `last synced ${new Date(iso).toLocaleString()}`;
}

// Add/edit the soul git remote (URL + PAT) and show live sync status, above the read-only
// tree/viewer on Business → Soul. The PAT field is write-only (mirrors _app.business.secrets.tsx):
// it never redisplays a stored credential, only shows whether one is set.
export function SoulGitConfigPanel({
  config,
  onSaved,
}: {
  config: SoulGitConfig;
  onSaved: () => void;
}) {
  const isAdmin = useIsAdmin();
  const [editing, setEditing] = useState(isAdmin && !config.remoteUrl);
  const [remoteUrl, setRemoteUrl] = useState(config.remoteUrl ?? "");
  const [credential, setCredential] = useState("");
  const [busy, setBusy] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await putGitConfig(remoteUrl.trim(), credential.trim() || undefined);
      setCredential("");
      setEditing(false);
      onSaved();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function onSync() {
    setSyncing(true);
    setError(null);
    try {
      await syncSoul();
      onSaved();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSyncing(false);
    }
  }

  const status = statusLabel(config.status);

  return (
    <div className="rounded-sm border border-border">
      {error ? (
        <p
          role="alert"
          className="m-3 mb-0 rounded-sm border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {error}
        </p>
      ) : null}

      {/* The status header is outside the editing branch: an admin with no remote lands straight in
          the connect form, and that is exactly the operator who needs to be told the soul is not
          connected. */}
      <div className="flex items-center gap-2 px-3 py-2">
        <GitBranch aria-hidden className="size-4 text-muted-foreground" />
        <span className="font-medium text-foreground">Git remote</span>
        <StatusBadge label={status.text} tone={status.tone} />
        {!editing ? (
          <div className="ml-auto flex items-center gap-1">
            {config.remoteUrl ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="cursor-pointer rounded-sm"
                disabled={syncing}
                onClick={onSync}
              >
                {syncing ? "Syncing…" : "Sync now"}
              </Button>
            ) : null}
            {isAdmin ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="cursor-pointer rounded-sm"
                onClick={() => setEditing(true)}
              >
                Edit
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>

      {!editing ? (
        <>
          {config.remoteUrl ? (
            <p className="truncate border-t border-border px-3 py-2 font-mono text-xs text-muted-foreground">
              {config.remoteUrl}
            </p>
          ) : (
            <p className="border-t border-border px-3 py-2 text-xs text-muted-foreground">
              No remote configured. This soul lives only on this machine.
            </p>
          )}
          {config.remoteUrl ? (
            <p className="truncate border-t border-border px-3 py-2 text-xs text-muted-foreground">
              {config.status.headSha ? (
                <>
                  <span className="font-mono">{config.status.headSha.slice(0, 7)}</span>
                  {" · "}
                </>
              ) : null}
              {formatLastSync(config.status.lastSyncAt)}
            </p>
          ) : null}
          {config.status.lastSyncError ? (
            <p
              role="alert"
              className="truncate border-t border-border px-3 py-2 text-xs text-destructive"
            >
              {friendlyGitError(config.status.lastSyncError)}
            </p>
          ) : null}
        </>
      ) : (
        <form onSubmit={onSubmit} className="flex flex-col gap-3 border-t border-border p-3">
          <p className="text-sm font-medium text-foreground">
            {config.remoteUrl ? "Edit git remote" : "Connect a git remote"}
          </p>
          <Field label="Remote URL">
            <Input
              value={remoteUrl}
              onChange={(e) => setRemoteUrl(e.target.value)}
              placeholder="https://github.com/org/soul.git"
            />
          </Field>
          <Field
            label="Personal access token"
            help={
              config.credentialSet
                ? "Already set. Leave blank to keep it."
                : "Optional. Needed only for private repositories."
            }
          >
            <Input
              type="password"
              value={credential}
              onChange={(e) => setCredential(e.target.value)}
              placeholder="••••••••"
            />
          </Field>
          <div className="flex justify-end gap-2">
            {config.remoteUrl ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="cursor-pointer rounded-sm"
                disabled={busy}
                onClick={() => {
                  setEditing(false);
                  setRemoteUrl(config.remoteUrl ?? "");
                  setCredential("");
                  setError(null);
                }}
              >
                Cancel
              </Button>
            ) : null}
            <Button
              type="submit"
              size="sm"
              className="cursor-pointer rounded-sm"
              disabled={busy || remoteUrl.trim().length === 0}
            >
              {busy ? "Saving…" : "Save"}
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}
