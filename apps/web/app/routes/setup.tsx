import { type MetaFunction, redirect, useNavigate } from "@remix-run/react";
import { AlertCircle, ArrowLeft, Check, Loader2 } from "lucide-react";
import { type FormEvent, type ReactNode, useRef, useState } from "react";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Select } from "~/components/ui/select";
import { Textarea } from "~/components/ui/textarea";
import { ApiError } from "~/lib/api";
import {
  type LlmConfig,
  type LlmProviderInfo,
  listProviders,
  putLlmConfig,
  putSecret,
} from "~/lib/settings";
import { completeSetup, getSetupStatus, setupAdmin, setupBusiness } from "~/lib/setup";
import { cn } from "~/lib/utils";

export const meta: MetaFunction = () => [{ title: "Setup · tulipfarm" }];

// Redirect to / if setup is already complete (both headless and wizard paths).
export async function clientLoader() {
  const { needsSetup } = await getSetupStatus();
  if (!needsSetup) throw redirect("/");
  return null;
}

type StepMeta = { label: string; description: string; optional?: boolean };

const STEPS = [
  {
    label: "Admin account",
    description:
      "This account owns the workspace. You can add more people from Settings once setup is done.",
  },
  {
    label: "Business profile",
    description:
      "Every Agent reads this to work out who it works for, so be specific about what you actually do.",
  },
  {
    label: "LLM setup",
    description:
      "Use one provider and Model ID for every effort preset. You can split them later in Settings.",
    optional: true,
  },
] as const satisfies readonly StepMeta[];

type Step = 0 | 1 | 2;

// Mobile keeps a 44px target and 16px text (below 16px iOS zooms the page on focus); desktop
// drops to the 36px control height the rest of the app uses.
const controlClass = "h-11 text-base sm:h-9 sm:text-sm";

function Field({
  id,
  label,
  hint,
  error,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  error?: string;
  children: ReactNode;
}) {
  const note = error ?? hint;
  return (
    <label htmlFor={id} className="grid gap-1.5 text-sm font-medium text-foreground">
      {label}
      {children}
      {note ? (
        <span
          className={cn(
            "text-xs font-normal",
            error ? "text-destructive" : "text-muted-foreground"
          )}
        >
          {note}
        </span>
      ) : null}
    </label>
  );
}

function ErrorAlert({ message }: { message: string }) {
  return (
    <p
      role="alert"
      className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
    >
      <AlertCircle aria-hidden className="mt-0.5 size-4 shrink-0" />
      <span>{message}</span>
    </p>
  );
}

// Desktop rail: the full step list, so the shape of the whole wizard stays visible.
function StepList({ steps, current }: { steps: readonly StepMeta[]; current: Step }) {
  return (
    <nav aria-label="Setup progress" className="hidden lg:block">
      <ol className="flex flex-col gap-0.5">
        {steps.map((s, i) => {
          const done = i < current;
          const active = i === current;
          return (
            <li
              key={s.label}
              aria-current={active ? "step" : undefined}
              className={cn(
                "flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm transition-colors",
                active ? "bg-secondary font-medium text-foreground" : "text-muted-foreground"
              )}
            >
              <span
                className={cn(
                  "flex size-5 shrink-0 items-center justify-center rounded-full border text-[0.625rem] tabular-nums",
                  done && "border-primary bg-primary text-primary-foreground",
                  active && "border-primary text-primary",
                  !done && !active && "border-border"
                )}
              >
                {done ? <Check aria-hidden className="size-3" /> : i + 1}
              </span>
              {s.label}
              {done ? <span className="sr-only">completed</span> : null}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

// Below lg there is no room for four labelled markers, so state is carried by text plus a bar.
function StepProgress({ steps, current }: { steps: readonly StepMeta[]; current: Step }) {
  return (
    <div className="lg:hidden">
      <p className="text-xs text-muted-foreground">
        Step <span className="tabular-nums">{current + 1}</span> of{" "}
        <span className="tabular-nums">{steps.length}</span>
      </p>
      <ol aria-hidden className="mt-2 flex gap-1.5">
        {steps.map((s, i) => (
          <li
            key={s.label}
            className={cn("h-1 flex-1 rounded-full", i <= current ? "bg-primary" : "bg-border")}
          />
        ))}
      </ol>
    </div>
  );
}

function Actions({
  busy,
  disabled,
  busyLabel,
  onBack,
  onSkip,
}: {
  busy: boolean;
  disabled: boolean;
  busyLabel: string;
  onBack?: () => void;
  onSkip?: () => void;
}) {
  return (
    <div className="mt-2 flex flex-col gap-2">
      <div className="flex gap-2">
        {onBack ? (
          <Button
            type="button"
            variant="outline"
            className="h-11 px-4 active:translate-y-px sm:h-10"
            onClick={onBack}
            disabled={busy}
          >
            <ArrowLeft aria-hidden />
            Back
          </Button>
        ) : null}
        <Button
          type="submit"
          className="h-11 flex-1 active:translate-y-px sm:h-10"
          disabled={busy || disabled}
        >
          {busy ? busyLabel : "Continue"}
        </Button>
      </div>
      {onSkip ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="mx-auto font-normal text-muted-foreground"
          onClick={onSkip}
          disabled={busy}
        >
          Skip for now
        </Button>
      ) : null}
    </div>
  );
}

// Step 1: admin account
function AdminStep({ onNext }: { onNext: () => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mismatch, setMismatch] = useState(false);
  const confirmRef = useRef<HTMLInputElement>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (password !== confirm) {
      setMismatch(true);
      confirmRef.current?.focus();
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
    <form onSubmit={onSubmit} className="flex flex-col gap-4">
      {error && <ErrorAlert message={error} />}
      <Field id="setup-email" label="Email" hint="You will sign in with this address.">
        <Input
          id="setup-email"
          type="email"
          autoComplete="username"
          className={controlClass}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
      </Field>
      <Field id="setup-password" label="Password" hint="At least 8 characters.">
        <Input
          id="setup-password"
          type="password"
          autoComplete="new-password"
          className={controlClass}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          minLength={8}
          required
        />
      </Field>
      <Field
        id="setup-confirm"
        label="Confirm password"
        error={mismatch ? "Both passwords must match." : undefined}
      >
        <Input
          id="setup-confirm"
          ref={confirmRef}
          type="password"
          autoComplete="new-password"
          className={controlClass}
          aria-invalid={mismatch || undefined}
          value={confirm}
          onChange={(e) => {
            setConfirm(e.target.value);
            setMismatch(false);
          }}
          required
        />
      </Field>
      <Actions
        busy={busy}
        busyLabel="Creating account…"
        disabled={!email || password.length < 8 || !confirm}
      />
    </form>
  );
}

type BusinessDraft = { name: string; description: string; website: string };

// Step 2: business profile
function BusinessStep({
  draft,
  onDraft,
  onBack,
  onNext,
}: {
  draft: BusinessDraft;
  onDraft: (next: BusinessDraft) => void;
  onBack: () => void;
  onNext: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await setupBusiness(draft.name.trim(), draft.description.trim(), draft.website.trim());
      onNext();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to save business profile.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4">
      {error && <ErrorAlert message={error} />}
      <Field id="setup-business-name" label="Business name">
        <Input
          id="setup-business-name"
          type="text"
          className={controlClass}
          value={draft.name}
          onChange={(e) => onDraft({ ...draft, name: e.target.value })}
          placeholder="Northgate Dental"
          required
        />
      </Field>
      <Field
        id="setup-business-description"
        label="What your business does"
        hint="Two or three sentences is plenty."
      >
        <Textarea
          id="setup-business-description"
          className="text-base sm:text-sm"
          value={draft.description}
          onChange={(e) => onDraft({ ...draft, description: e.target.value })}
          placeholder="Family dental practice in Portland. Mostly preventive care, with some implant work."
        />
      </Field>
      <Field
        id="setup-business-website"
        label="Website (optional)"
        hint="Agents use this when they need to reference or link to your site."
      >
        <Input
          id="setup-business-website"
          type="url"
          inputMode="url"
          className={controlClass}
          value={draft.website}
          onChange={(e) => onDraft({ ...draft, website: e.target.value })}
          placeholder="https://northgatedental.com"
        />
      </Field>
      <Actions busy={busy} busyLabel="Saving…" disabled={!draft.name.trim()} onBack={onBack} />
    </form>
  );
}

const DEFAULT_MODEL: Record<string, string> = {
  anthropic: "claude-sonnet-4-6",
  openai: "gpt-4o",
  azure: "gpt-4o",
  "openai-compatible": "",
  "claude-code": "sonnet",
};

type LlmDraft = { providerId: string; model: string; fieldValues: Record<string, string> };
export function buildSetupLlmConfig(providerId: string, model: string): LlmConfig {
  const entry = { provider: providerId, model: model.trim() };
  return {
    tiers: {
      quick: { providers: [entry] },
      standard: { providers: [entry] },
      complex: { providers: [entry] },
    },
    // One provider seeds every preset; Settings splits them once more models are configured.
    presets: { default: "balanced" },
  };
}

// Step 3: LLM setup — uses the same registry and storage endpoints as Settings › Secrets + LLM Config.
function LlmStep({
  providers,
  draft,
  onDraft,
  onBack,
  onNext,
}: {
  providers: LlmProviderInfo[];
  draft: LlmDraft;
  onDraft: (next: LlmDraft) => void;
  onBack: () => void;
  onNext: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selected = providers.find((p) => p.id === draft.providerId);

  function setVal(key: string, v: string) {
    onDraft({ ...draft, fieldValues: { ...draft.fieldValues, [key]: v } });
  }

  function onProviderChange(id: string) {
    onDraft({ providerId: id, model: DEFAULT_MODEL[id] ?? "", fieldValues: {} });
  }

  const canSubmit =
    !!selected &&
    selected.fields
      .filter((f) => !f.optional)
      .every((f) => (draft.fieldValues[f.key] ?? "").trim().length > 0) &&
    draft.model.trim().length > 0;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      const filled = selected.fields.filter(
        (f) => (draft.fieldValues[f.key] ?? "").trim().length > 0
      );
      await Promise.all(
        filled.map((f) => putSecret(f.key, (draft.fieldValues[f.key] ?? "").trim()))
      );
      await putLlmConfig(buildSetupLlmConfig(draft.providerId, draft.model));
      onNext();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to save LLM configuration.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4">
      {error && <ErrorAlert message={error} />}
      <Field id="setup-provider" label="LLM provider">
        <Select
          id="setup-provider"
          className={controlClass}
          value={draft.providerId}
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
        </Select>
      </Field>
      {selected?.fields.map((field) => (
        <Field
          key={field.key}
          id={`setup-${field.key}`}
          label={`${field.label}${field.optional ? " (optional)" : ""}`}
          hint={field.hint ?? (field.kind === "secret" ? "Stored encrypted." : undefined)}
        >
          <Input
            id={`setup-${field.key}`}
            className={controlClass}
            type={field.kind === "secret" ? "password" : "text"}
            value={draft.fieldValues[field.key] ?? ""}
            onChange={(e) => setVal(field.key, e.target.value)}
            placeholder={field.placeholder ?? (field.kind === "secret" ? "sk-…" : "")}
            autoComplete="off"
          />
        </Field>
      ))}
      <Field
        id="setup-model"
        label="Model ID"
        hint="The provider's exact model identifier. Setup uses it for every effort preset."
      >
        <Input
          id="setup-model"
          className={controlClass}
          value={draft.model}
          onChange={(e) => onDraft({ ...draft, model: e.target.value })}
          placeholder={DEFAULT_MODEL[draft.providerId] ?? "e.g. gpt-4o"}
          autoComplete="off"
        />
      </Field>
      <Actions
        busy={busy}
        busyLabel="Saving…"
        disabled={!canSubmit}
        onBack={onBack}
        onSkip={onNext}
      />
    </form>
  );
}

export default function SetupRoute() {
  const navigate = useNavigate();
  const [step, setStep] = useState<Step>(0);
  const [finishing, setFinishing] = useState(false);
  const [finishError, setFinishError] = useState<string | null>(null);
  const [providers, setProviders] = useState<LlmProviderInfo[]>([]);
  // Drafts live here, not in the step components, so stepping back preserves what was typed.
  const [business, setBusiness] = useState<BusinessDraft>({
    name: "",
    description: "",
    website: "",
  });
  const [llm, setLlm] = useState<LlmDraft>({
    providerId: "anthropic",
    model: DEFAULT_MODEL.anthropic ?? "",
    fieldValues: {},
  });
  const headingRef = useRef<HTMLHeadingElement>(null);

  const current: StepMeta = STEPS[step] ?? STEPS[0];

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

  const goTo = (next: Step) => {
    setStep(next);
    // The whole form swaps on step change, which would otherwise drop focus to <body>.
    headingRef.current?.focus();
  };

  const advance = () => {
    if (step < STEPS.length - 1) {
      goTo((step + 1) as Step);
    } else {
      void finish();
    }
  };

  const back = () => goTo(Math.max(0, step - 1) as Step);

  // The admin step's auto-login is what makes the (authenticated) provider list readable: fetch it
  // once, then advance. A failed read leaves the static Anthropic/OpenAI fallback in place.
  const advanceFromAdmin = () => {
    listProviders()
      .then((list) => {
        setProviders(list);
        const first = list[0];
        if (!first) return;
        setLlm((draft) =>
          list.some((p) => p.id === draft.providerId)
            ? draft
            : { providerId: first.id, model: DEFAULT_MODEL[first.id] ?? "", fieldValues: {} }
        );
      })
      .catch(() => {});
    advance();
  };

  return (
    <main className="min-h-svh px-6 py-12 sm:py-16 lg:py-24">
      <div className="mx-auto grid w-full max-w-md items-start gap-10 lg:max-w-3xl lg:grid-cols-[13rem_minmax(0,1fr)] lg:gap-12">
        <aside className="flex flex-col gap-8">
          <div>
            <p className="text-[0.625rem] font-medium uppercase tracking-[0.2em] text-primary">
              [ SETUP ]
            </p>
            <p className="mt-1 text-2xl font-semibold text-foreground">tulipfarm</p>
          </div>
          <StepList steps={STEPS} current={step} />
        </aside>

        <div className="flex flex-col gap-6">
          <div>
            <StepProgress steps={STEPS} current={step} />
            <div className="mt-4 flex items-center gap-2 lg:mt-0">
              <h1
                ref={headingRef}
                tabIndex={-1}
                className="text-xl font-semibold text-foreground outline-none"
              >
                {current.label}
              </h1>
              {current.optional ? <Badge>Optional</Badge> : null}
            </div>
            <p className="mt-2 text-sm leading-6 text-pretty text-muted-foreground">
              {current.description}
            </p>
          </div>

          {finishError && <ErrorAlert message={finishError} />}

          {step === 0 && <AdminStep onNext={advanceFromAdmin} />}
          {step === 1 && (
            <BusinessStep draft={business} onDraft={setBusiness} onBack={back} onNext={advance} />
          )}
          {step === 2 && (
            <LlmStep
              providers={providers}
              draft={llm}
              onDraft={setLlm}
              onBack={back}
              onNext={advance}
            />
          )}

          {finishing && (
            <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 aria-hidden className="size-4 motion-safe:animate-spin" />
              Finishing setup…
            </p>
          )}
        </div>
      </div>
    </main>
  );
}
