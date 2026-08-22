import { type MetaFunction, useNavigate, useSearchParams } from "@remix-run/react";
import { type FormEvent, useState } from "react";
import { Button } from "~/components/ui/button";
import { ApiError, login } from "~/lib/api";

export const meta: MetaFunction = () => [{ title: "Sign in · tulipfarm" }];

const inputClass =
  "w-full rounded-sm border border-border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-60";

// Standalone (outside the _app gate) email+password sign-in. On success the API has set the session
// + CSRF cookies, so we just navigate into the app (honoring ?redirectTo). The _app loader then sees
// a valid session and renders.
export default function Login() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(email.trim(), password);
      const to = params.get("redirectTo") ?? "/";
      // Block protocol-relative (//evil.com) and backslash-relative (/\evil.com) open redirects.
      const safe = to.startsWith("/") && !to.startsWith("//") && !to.startsWith("/\\");
      navigate(safe ? to : "/", { replace: true });
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : "could not reach the API — is it running on :4010?"
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="h-full min-h-0 overflow-y-auto">
      <section className="mx-auto flex min-h-full max-w-sm flex-col justify-center px-6 py-16">
        <p className="text-[0.625rem] font-medium uppercase tracking-[0.2em] text-primary">
          [ SIGN IN ]
        </p>
        <h1 className="mt-1 text-2xl font-semibold text-foreground">tulipfarm</h1>
        <p className="mt-1 text-sm text-muted-foreground">Sign in to this tenant.</p>

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
            email
            <input
              type="email"
              autoComplete="username"
              className={inputClass}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              aria-label="email"
            />
          </label>

          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            password
            <input
              type="password"
              autoComplete="current-password"
              className={inputClass}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              aria-label="password"
            />
          </label>

          <Button
            type="submit"
            className="mt-1 rounded-sm"
            disabled={busy || email.trim().length === 0 || password.length === 0}
          >
            {busy ? "Signing in…" : "Sign in"}
          </Button>
        </form>
      </section>
    </div>
  );
}
