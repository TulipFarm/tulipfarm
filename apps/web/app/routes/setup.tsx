import { type MetaFunction, redirect, useNavigate } from "@remix-run/react";
import { type FormEvent, useEffect, useState } from "react";
import { Button } from "~/components/ui/button";
import { ApiError } from "~/lib/api";
import { type LlmProviderInfo, listProviders, putLlmConfig, putSecret } from "~/lib/settings";
import { completeSetup, getSetupStatus, setupAdmin, setupBusiness, setupGit } from "~/lib/setup";

export const meta: MetaFunction = () => [{ title: "Setup · tulipfarm" }];

// Redirect to / if setup is already complete (both headless and wizard paths).
export async function clientLoader() {
  const { needsSetup } = await getSetupStatus();
  if (!needsSetup) throw redirect("/");
  return null;
}

const STEPS = ["Admin account", "Business profile", "LLM setup", "Soul backup"] as const;
type Step = 0 | 1 | 2 | 3;

const inputClass =
  "w-full rounded-sm border border-border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-60";

function StepIndicator({ current }: { current: Step }) {
  return (
    <div className="flex items-center gap-2 mb-8">
      {STEPS.map((label, i) => (
        <div key={label} className="flex items-center gap-2">
          <div
            className={[
              "flex h-6 w-6 items-center justify-center rounded-full text-[0.625rem] font-medium",
              i < current
                ? "bg-primary text-primary-foreground"
                : i === current
                  ? "border-2 border-primary text-primary"
                  : "border border-border text-muted-foreground",
            ].join(" ")}
          >
            {i < current ? "✓" : i + 1}
          </div>
          <span
            className={`hidden text-xs sm:inline ${i === current ? "text-foreground" : "text-muted-foreground"}`}
          >
            {label}
          </span>
          {i < STEPS.length - 1 && <div className="h-px w-4 bg-border" />}
        </div>
      ))}
    </div>
  );
}

function ErrorAlert({ message }: { message: string }) {
  return (
    <p
      role="alert"
      className="rounded-sm border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive"
    >
      {message}
    </p>
  );
}

// Step 1: admin account
function AdminStep({ onNext }: { onNext: () => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (password !== confirm) {
      setError("Passwords do not match.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await setupAdmin(email.trim(), password);
      onNext();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Setup failed — is the API reachable?");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-3">
      {error && <ErrorAlert message={error} />}
      <label className="flex flex-col gap-1 text-xs text-muted-foreground">
        email
        <input
          type="email"
          autoComplete="username"
          className={inputClass}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
      </label>
      <label className="flex flex-col gap-1 text-xs text-muted-foreground">
        password (min 8 characters)
        <input
          type="password"
          autoComplete="new-password"
          className={inputClass}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          minLength={8}
          required
        />
      </label>
      <label className="flex flex-col gap-1 text-xs text-muted-foreground">
        confirm password
        <input
          type="password"
          autoComplete="new-password"
          className={inputClass}
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          required
        />
      </label>
      <Button
        type="submit"
        className="mt-1 rounded-sm"
        disabled={busy || !email || password.length < 8 || !confirm}
      >
        {busy ? "Creating account…" : "Continue"}
      </Button>
    </form>
  );
}

// Step 2: business profile
function BusinessStep({ onNext }: { onNext: () => void }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await setupBusiness(name.trim(), description.trim());
      onNext();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to save business profile.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-3">
      {error && <ErrorAlert message={error} />}
      <label className="flex flex-col gap-1 text-xs text-muted-foreground">
        business name
        <input
          type="text"
          className={inputClass}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Acme Corp"
          required
        />
      </label>
      <label className="flex flex-col gap-1 text-xs text-muted-foreground">
        brief description
        <textarea
          className={`${inputClass} resize-none`}
          rows={3}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="What does your business do?"
        />
      </label>
      <Button type="submit" className="mt-1 rounded-sm" disabled={busy || !name.trim()}>
        {busy ? "Saving…" : "Continue"}
      </Button>
    </form>
  );
}

const DEFAULT_MODEL: Record<string, string> = {
  anthropic: "claude-sonnet-4-6",
  openai: "gpt-4o",
  azure: "gpt-4o",
  "openai-compatible": "",
};

// Step 3: LLM setup — uses the same registry and storage endpoints as Settings › Secrets + LLM Config.
function LlmStep({ onNext }: { onNext: () => void }) {
  const [providers, setProviders] = useState<LlmProviderInfo[]>([]);
  const [providerId, setProviderId] = useState("anthropic");
  const [fieldValues, setFieldValues] = useState<Record<string, string>>({});
  const [model, setModel] = useState(DEFAULT_MODEL["anthropic"] ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listProviders()
      .then((list) => {
        setProviders(list);
        if (list.length > 0 && list[0]) {
          setProviderId(list[0].id);
          setModel(DEFAULT_MODEL[list[0].id] ?? "");
        }
      })
      .catch(() => {});
  }, []);

  const selected = providers.find((p) => p.id === providerId);

  function setVal(key: string, v: string) {
    setFieldValues((prev) => ({ ...prev, [key]: v }));
  }

  function onProviderChange(id: string) {
    setProviderId(id);
    setFieldValues({});
    setModel(DEFAULT_MODEL[id] ?? "");
  }

  const canSubmit =
    !!selected &&
    selected.fields
      .filter((f) => !f.optional)
      .every((f) => (fieldValues[f.key] ?? "").trim().length > 0) &&
    model.trim().length > 0;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      const filled = selected.fields.filter((f) => (fieldValues[f.key] ?? "").trim().length > 0);
      await Promise.all(filled.map((f) => putSecret(f.key, fieldValues[f.key]!.trim())));
      const entry = { provider: providerId, model: model.trim() };
      await putLlmConfig({
        tiers: {
          quick: { providers: [entry] },
          standard: { providers: [entry] },
          complex: { providers: [entry] },
        },
      });
      onNext();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to save LLM configuration.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-3">
      {error && <ErrorAlert message={error} />}
      <label className="flex flex-col gap-1 text-xs text-muted-foreground">
        LLM provider
        <select
          className={inputClass}
          value={providerId}
          onChange={(e) => onProviderChange(e.target.value)}
        >
          {providers.length > 0 ? (
            providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))
          ) : (
            <>
              <option value="anthropic">Anthropic</option>
              <option value="openai">OpenAI</option>
            </>
          )}
        </select>
      </label>
      {selected?.fields.map((field) => (
        <label key={field.key} className="flex flex-col gap-1 text-xs text-muted-foreground">
          {field.label}
          {field.optional ? " (optional)" : ""}
          <input
            className={inputClass}
            type={field.kind === "secret" ? "password" : "text"}
            value={fieldValues[field.key] ?? ""}
            onChange={(e) => setVal(field.key, e.target.value)}
            placeholder={field.placeholder ?? (field.kind === "secret" ? "sk-…" : "")}
            autoComplete="off"
          />
        </label>
      ))}
      <label className="flex flex-col gap-1 text-xs text-muted-foreground">
        model
        <input
          className={inputClass}
          value={model}
          onChange={(e) => setModel(e.target.value)}
          placeholder={DEFAULT_MODEL[providerId] ?? "e.g. gpt-4o"}
          autoComplete="off"
        />
      </label>
      <Button type="submit" className="mt-1 rounded-sm" disabled={busy || !canSubmit}>
        {busy ? "Saving…" : "Continue"}
      </Button>
      <Button type="button" variant="ghost" className="rounded-sm text-xs" onClick={onNext}>
        Skip for now — configure in Settings later
      </Button>
    </form>
  );
}

// Step 4: soul git backup (optional)
function GitStep({ onNext }: { onNext: () => void }) {
  const [remoteUrl, setRemoteUrl] = useState("");
  const [credentials, setCredentials] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await setupGit(remoteUrl.trim(), credentials.trim() || undefined);
      onNext();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to save git config.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-3">
      {error && <ErrorAlert message={error} />}
      <p className="text-sm text-muted-foreground">
        Back up your soul (agents, resources, config) to a private git repository. You can configure
        this later in Settings.
      </p>
      <label className="flex flex-col gap-1 text-xs text-muted-foreground">
        git remote URL (HTTPS)
        <input
          type="url"
          className={inputClass}
          value={remoteUrl}
          onChange={(e) => setRemoteUrl(e.target.value)}
          placeholder="https://github.com/your-org/soul.git"
        />
      </label>
      <label className="flex flex-col gap-1 text-xs text-muted-foreground">
        access token (optional)
        <input
          type="password"
          autoComplete="off"
          className={inputClass}
          value={credentials}
          onChange={(e) => setCredentials(e.target.value)}
          placeholder="ghp_…"
        />
      </label>
      <div className="flex gap-2">
        <Button type="submit" className="flex-1 rounded-sm" disabled={busy || !remoteUrl.trim()}>
          {busy ? "Saving…" : "Continue"}
        </Button>
        <Button
          type="button"
          variant="outline"
          className="rounded-sm"
          onClick={onNext}
          disabled={busy}
        >
          Skip
        </Button>
      </div>
    </form>
  );
}

export default function SetupRoute() {
  const navigate = useNavigate();
  const [step, setStep] = useState<Step>(0);
  const [finishing, setFinishing] = useState(false);
  const [finishError, setFinishError] = useState<string | null>(null);

  async function finish() {
    setFinishing(true);
    setFinishError(null);
    try {
      await completeSetup();
      navigate("/", { replace: true });
    } catch (err) {
      setFinishError(err instanceof ApiError ? err.message : "Failed to complete setup.");
      setFinishing(false);
    }
  }

  const advance = () => {
    if (step < 3) {
      setStep((s) => (s + 1) as Step);
    } else {
      void finish();
    }
  };

  return (
    <section className="mx-auto flex min-h-svh max-w-sm flex-col justify-center px-6 py-16">
      <p className="text-[0.625rem] font-medium uppercase tracking-[0.2em] text-primary">
        [ SETUP ]
      </p>
      <h1 className="mt-1 text-2xl font-semibold text-foreground">tulipfarm</h1>
      <p className="mt-1 text-sm text-muted-foreground">Let's get you set up.</p>

      <div className="mt-8">
        <StepIndicator current={step} />

        <h2 className="mb-4 text-base font-medium">{STEPS[step]}</h2>

        {finishError && <ErrorAlert message={finishError} />}

        {step === 0 && <AdminStep onNext={advance} />}
        {step === 1 && <BusinessStep onNext={advance} />}
        {step === 2 && <LlmStep onNext={advance} />}
        {step === 3 && <GitStep onNext={advance} />}

        {step === 3 && finishing && (
          <p className="mt-4 text-sm text-muted-foreground">Finishing setup…</p>
        )}
      </div>
    </section>
  );
}
