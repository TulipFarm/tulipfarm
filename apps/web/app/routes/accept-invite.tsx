import { type MetaFunction, useNavigate } from "@remix-run/react";
import { type FormEvent, useEffect, useState } from "react";
import { Button } from "~/components/ui/button";
import { ApiError, acceptInvite, previewInvite } from "~/lib/api";

export const meta: MetaFunction = () => [{ title: "Accept invite · tulipfarm" }];

const inputClass =
  "w-full rounded-sm border border-border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-60";

/** The invite token stays in the URL fragment, so browsers never send it to servers. */
function tokenFromHash(): string {
  const hash = window.location.hash.startsWith("#") ? window.location.hash.slice(1) : "";
  return new URLSearchParams(hash).get("token") ?? "";
}

function isDeadLink(err: unknown): boolean {
  return err instanceof ApiError && err.status === 404;
}

/**
 * Standalone (outside the `_app` gate) invite redemption: the invited person chooses their own
 * password here, so an admin never mints or relays a credential for them.
 */
export default function AcceptInvite() {
  const navigate = useNavigate();
  const [token] = useState(tokenFromHash);
  const [email, setEmail] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dead, setDead] = useState(false);

  useEffect(() => {
    if (!token) {
      setError("this link is missing its invite token");
      setDead(true);
      setLoading(false);
      return;
    }
    let cancelled = false;
    previewInvite(token)
      .then((offer) => {
        if (!cancelled) setEmail(offer.email);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof ApiError ? err.message : "could not reach the API");
        setDead(isDeadLink(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (password !== confirmPassword) {
      setError("passwords do not match");
      return;
    }
    setBusy(true);
    try {
      await acceptInvite(token, password);
      navigate("/", { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "could not reach the API");
      if (isDeadLink(err)) setDead(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="h-full min-h-0 overflow-y-auto">
      <section className="mx-auto flex min-h-full max-w-sm flex-col justify-center px-6 py-16">
        <p className="text-xs font-medium text-primary">Accept invite</p>
        <h1 className="mt-1 text-2xl font-semibold text-foreground">Choose your password</h1>

        {loading ? (
          <p className="mt-1 text-sm text-muted-foreground">Checking this link…</p>
        ) : dead ? (
          <>
            <p role="alert" className="mt-1 text-sm text-destructive">
              error: {error}
            </p>
            <p className="mt-3 text-sm text-muted-foreground">
              Invite links are single-use and expire. Ask an admin for a new one.
            </p>
          </>
        ) : (
          <>
            <p className="mt-1 text-sm text-muted-foreground">
              Setting the password for <strong className="text-foreground">{email}</strong>.
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
                password
                <input
                  type="password"
                  autoComplete="new-password"
                  className={inputClass}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  aria-label="password"
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
                disabled={busy || password.length === 0 || confirmPassword.length === 0}
              >
                {busy ? "Setting password…" : "Set password and sign in"}
              </Button>
            </form>
          </>
        )}
      </section>
    </div>
  );
}
