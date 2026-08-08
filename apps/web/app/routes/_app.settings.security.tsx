import { type FormEvent, useState } from "react";
import { Button } from "~/components/ui/button";
import { ApiError, changePassword } from "~/lib/api";

const inputClass =
  "w-full rounded-sm border border-border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-60";

// Self-service password change. The current password is required by the API — possession of a
// session is not enough to replace the credential behind it.
export default function SecuritySettings() {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setDone(false);
    // Only the confirm-field match is checked here — the API owns every password rule and its
    // message is what gets rendered, so restating the length here would be a second source of truth
    // to drift. A rejected password costs a round trip and nothing else.
    if (newPassword !== confirmPassword) {
      setError("passwords do not match");
      return;
    }
    setBusy(true);
    try {
      await changePassword(currentPassword, newPassword);
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setDone(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "could not reach the API");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="flex max-w-sm flex-col gap-3">
      {error ? (
        <p
          role="alert"
          className="rounded-sm border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          error: {error}
        </p>
      ) : null}
      {done ? (
        <p
          role="status"
          className="rounded-sm border border-primary/50 bg-primary/5 px-3 py-2 text-sm"
        >
          Password updated. This session stays signed in; any other is not affected.
        </p>
      ) : null}

      <label className="flex flex-col gap-1 text-xs text-muted-foreground">
        current password
        <input
          type="password"
          autoComplete="current-password"
          className={inputClass}
          value={currentPassword}
          onChange={(e) => setCurrentPassword(e.target.value)}
          aria-label="current password"
        />
      </label>

      <label className="flex flex-col gap-1 text-xs text-muted-foreground">
        new password
        <input
          type="password"
          autoComplete="new-password"
          className={inputClass}
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
          aria-label="new password"
        />
      </label>

      <label className="flex flex-col gap-1 text-xs text-muted-foreground">
        confirm new password
        <input
          type="password"
          autoComplete="new-password"
          className={inputClass}
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
          aria-label="confirm new password"
        />
      </label>

      <Button
        type="submit"
        className="mt-1 self-start rounded-sm"
        disabled={
          busy ||
          currentPassword.length === 0 ||
          newPassword.length === 0 ||
          confirmPassword.length === 0
        }
      >
        {busy ? "Saving…" : "Change password"}
      </Button>
    </form>
  );
}
