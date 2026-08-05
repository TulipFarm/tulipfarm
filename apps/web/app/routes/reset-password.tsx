import { type MetaFunction, useNavigate } from "@remix-run/react";
import { type FormEvent, useState } from "react";
import { Button } from "~/components/ui/button";
import { ApiError, changePassword } from "~/lib/api";

export const meta: MetaFunction = () => [{ title: "Reset password · tulipfarm" }];

const inputClass =
  "w-full rounded-sm border border-border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-60";

// Standalone (outside the _app gate) forced password reset. Reached after login or the _app loader
// redirects a user whose account still has mustResetPassword set. Requires an active session — the
// API's change-password route 401s without one.
export default function ResetPassword() {
  const navigate = useNavigate();
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (newPassword.length < 8) {
      setError("password must be at least 8 characters");
      return;
    }
    if (newPassword !== confirmPassword) {
      setError("passwords do not match");
      return;
    }
    setBusy(true);
    try {
      await changePassword(newPassword);
      navigate("/", { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "could not reach the API");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mx-auto flex min-h-svh max-w-sm flex-col justify-center px-6 py-16">
      <p className="text-[0.625rem] font-medium uppercase tracking-[0.2em] text-primary">
        [ RESET PASSWORD ]
      </p>
      <h1 className="mt-1 text-2xl font-semibold text-foreground">Set a new password</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Your account was created with a temporary password. Choose a new one to continue.
      </p>

      <form onSubmit={onSubmit} className="mt-8 flex flex-col gap-3">
        {error ? (
          <p
            role="alert"
            className="rounded-sm border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          >
            error: {error}
          </p>
        ) : null}

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
          confirm password
          <input
            type="password"
            autoComplete="new-password"
            className={inputClass}
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            aria-label="confirm password"
          />
        </label>

        <Button
          type="submit"
          className="mt-1 rounded-sm"
          disabled={busy || newPassword.length === 0 || confirmPassword.length === 0}
        >
          {busy ? "Saving…" : "Set password"}
        </Button>
      </form>
    </section>
  );
}
