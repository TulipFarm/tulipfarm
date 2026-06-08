import type { MetaFunction } from "@remix-run/react";
import { useEffect, useState } from "react";
import { Button } from "~/components/ui/button";
import { type ApiResult, apiGet, apiPost } from "~/lib/setup-api";
import { cn } from "~/lib/utils";

export const meta: MetaFunction = () => [{ title: "Setup · tulipfarm" }];

// First-run setup wizard (INST-003). Standalone page outside the _app shell — it
// runs before any admin/session exists. Steps are blocking and in order; the
// /setup/admin call sets the session cookie so the later steps are authenticated.
type Step = "loading" | "admin" | "business" | "llm" | "done" | "ready";

const STEP_NO: Partial<Record<Step, number>> = { admin: 1, business: 2, llm: 3 };

const field =
  "w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground outline-none transition-[color,box-shadow] focus-visible:ring-[3px] focus-visible:ring-ring/50 placeholder:text-muted-foreground";

function Label({ children }: { children: React.ReactNode }) {
  return <span className="mb-1 block text-xs font-medium text-muted-foreground">{children}</span>;
}

export default function SetupWizard() {
  const [step, setStep] = useState<Step>("loading");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [provider, setProvider] = useState<"anthropic" | "openai">("anthropic");
  const [apiKey, setApiKey] = useState("");

  useEffect(() => {
    apiGet<{ needsSetup: boolean }>("/api/v1/setup/status")
      .then((s) => setStep(s.needsSetup ? "admin" : "ready"))
      .catch(() => setStep("admin"));
  }, []);

  // Run an API call, advancing to `next` on success and surfacing the error otherwise.
  async function run(call: () => Promise<ApiResult>, next: Step): Promise<void> {
    setBusy(true);
    setError("");
    try {
      const res = await call();
      if (res.ok) setStep(next);
      else setError(res.error ?? "something went wrong");
    } finally {
      setBusy(false);
    }
  }

  const submitAdmin = () =>
    run(() => apiPost("/api/v1/setup/admin", { email, password }), "business");
  const submitBusiness = () =>
    run(() => apiPost("/api/v1/setup/business", { name, description }), "llm");
  const submitLlm = () =>
    run(async () => {
      const set = await apiPost("/api/v1/setup/llm", { provider, apiKey });
      if (!set.ok) return set;
      return apiPost("/api/v1/setup/complete", {});
    }, "done");

  return (
    <div className="grid min-h-svh place-items-center bg-background px-6 py-12 text-foreground">
      <div className="w-full max-w-md">
        <header className="mb-6">
          <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground">
            <span className="text-primary">[</span>setup<span className="text-primary">]</span>
            {STEP_NO[step] ? <span className="ml-2 tabular-nums">{STEP_NO[step]}/3</span> : null}
          </p>
          <h1 className="mt-2 text-2xl font-bold tracking-tight">
            <span aria-hidden className="animate-cursor text-primary">
              ▍
            </span>
            tulipfarm
          </h1>
        </header>

        <div className="rounded-lg border border-border bg-background p-6">
          {step === "loading" && (
            <p className="text-sm text-muted-foreground">Checking setup status…</p>
          )}

          {step === "ready" && (
            <Ready
              title="Already set up"
              body="This instance has an admin. Head to the app to sign in."
            />
          )}

          {step === "done" && (
            <Ready title="You're all set" body="Setup complete. Open tulipfarm to get started." />
          )}

          {step === "admin" && (
            <Form
              heading="Create your admin account"
              hint="The first account becomes the instance owner."
              busy={busy}
              error={error}
              cta="Create admin"
              onSubmit={submitAdmin}
              canSubmit={Boolean(email) && password.length >= 8}
            >
              <label className="block">
                <Label>Email</Label>
                <input
                  className={field}
                  type="email"
                  autoComplete="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@business.com"
                />
              </label>
              <label className="block">
                <Label>Password (min 8 characters)</Label>
                <input
                  className={field}
                  type="password"
                  autoComplete="new-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                />
              </label>
            </Form>
          )}

          {step === "business" && (
            <Form
              heading="Tell us about your business"
              hint="Seeds your soul + onboarding. You can change this later."
              busy={busy}
              error={error}
              cta="Continue"
              onSubmit={submitBusiness}
              canSubmit={name.trim().length > 0}
            >
              <label className="block">
                <Label>Business name</Label>
                <input
                  className={field}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Acme Co."
                />
              </label>
              <label className="block">
                <Label>Short description</Label>
                <textarea
                  className={cn(field, "min-h-20 resize-y")}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="What your business does, in a sentence or two."
                />
              </label>
            </Form>
          )}

          {step === "llm" && (
            <Form
              heading="Connect an LLM provider"
              hint="Stored encrypted. Validated on first use."
              busy={busy}
              error={error}
              cta="Finish setup"
              onSubmit={submitLlm}
              canSubmit={apiKey.trim().length > 0}
            >
              <label className="block">
                <Label>Provider</Label>
                <select
                  className={field}
                  value={provider}
                  onChange={(e) => setProvider(e.target.value as "anthropic" | "openai")}
                >
                  <option value="anthropic">Anthropic (Claude)</option>
                  <option value="openai">OpenAI</option>
                </select>
              </label>
              <label className="block">
                <Label>API key</Label>
                <input
                  className={field}
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder="sk-…"
                />
              </label>
            </Form>
          )}
        </div>
      </div>
    </div>
  );
}

function Form({
  heading,
  hint,
  children,
  busy,
  error,
  cta,
  canSubmit,
  onSubmit,
}: {
  heading: string;
  hint: string;
  children: React.ReactNode;
  busy: boolean;
  error: string;
  cta: string;
  canSubmit: boolean;
  onSubmit: () => void;
}) {
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (canSubmit && !busy) onSubmit();
      }}
    >
      <div>
        <h2 className="text-base font-semibold text-foreground">{heading}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{hint}</p>
      </div>
      {children}
      {error ? (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}
      <Button type="submit" disabled={!canSubmit || busy} className="mt-1">
        {busy ? "Working…" : cta}
      </Button>
    </form>
  );
}

function Ready({ title, body }: { title: string; body: string }) {
  return (
    <div className="flex flex-col gap-4">
      <div>
        <h2 className="flex items-center gap-2 text-base font-semibold text-foreground">
          <span aria-hidden className="text-primary">
            [✓]
          </span>
          {title}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">{body}</p>
      </div>
      <Button asChild className="mt-1">
        <a href="/">Open tulipfarm →</a>
      </Button>
    </div>
  );
}
