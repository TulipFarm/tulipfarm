import { Check, ExternalLink } from "lucide-react";
import type * as React from "react";
import { useState } from "react";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { ApiError } from "~/lib/api";
import {
  type AuthStepKind,
  type AuthStepSummary,
  connectIntegration,
  type RequiredEnvVar,
  startAuthStep,
} from "~/lib/integrations";
import { cn } from "~/lib/utils";

/*
 * Manifest steps drive all Integration auth. Field descriptors arrive with the detail payload;
 * provider steps start only when committed, so one-use state is not burned on render.
 */

const DEFAULT_TITLE: Record<AuthStepKind, string> = {
  fields: "Enter credentials",
  app_manifest: "Create the app",
  oauth2: "Authorize access",
  install: "Install the app",
  webhook: "Connect the channel",
};

/** Verb for the button that hands the operator off to the provider. Keyed by kind, never by slug. */
const HANDOFF_VERB: Record<Exclude<AuthStepKind, "fields">, string> = {
  app_manifest: "Create app on",
  oauth2: "Authorize on",
  install: "Install on",
  webhook: "Register with",
};

function errMessage(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  return e instanceof Error ? e.message : "request failed";
}

/**
 * Hands the browser to the provider with a POST body. GitHub's app-manifest flow accepts the app
 * definition only as a form field, so a plain redirect cannot express it.
 */
function postForm(url: string, field: string, value: string, newTab: boolean): void {
  const form = document.createElement("form");
  form.method = "POST";
  form.action = url;
  if (newTab) form.target = "_blank";
  const input = document.createElement("input");
  input.type = "hidden";
  input.name = field;
  input.value = value;
  form.append(input);
  document.body.append(form);
  form.submit();
}

/**
 * Starts one step that does not collect fields, and hands the browser over if the step needs
 * it. Returns `"completed"` when the server finished the step by itself — a `webhook`
 * registration talks to the provider from the API, so there is nothing to navigate to and the
 * caller should just refresh.
 */
export async function startHandoff(
  slug: string,
  stepIndex: number,
  newTab = false,
  org?: string
): Promise<"handed_off" | "completed"> {
  // Passed only when set, so a call with no org keeps matching call sites that never knew of it.
  const action = org
    ? await startAuthStep(slug, stepIndex, org)
    : await startAuthStep(slug, stepIndex);
  if (action.action === "redirect") {
    if (newTab) window.open(action.url, "_blank", "noopener,noreferrer");
    else window.location.assign(action.url);
    return "handed_off";
  }
  if (action.action === "form_post") {
    postForm(action.url, action.field, action.value, newTab);
    return "handed_off";
  }
  if (action.action === "completed") return "completed";
  throw new Error("This step expects credentials. Reload the page to continue.");
}

type StepState = "done" | "current" | "upcoming";

function StepMarker({ state, ordinal }: { state: StepState; ordinal: number }) {
  if (state === "done") {
    return (
      <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-foreground text-background">
        <Check className="size-3" aria-hidden />
      </span>
    );
  }
  return (
    <span
      className={cn(
        "flex size-5 shrink-0 items-center justify-center rounded-full border text-[11px] font-medium tabular-nums",
        state === "current"
          ? "border-foreground text-foreground"
          : "border-border text-muted-foreground"
      )}
    >
      {ordinal}
    </span>
  );
}

function stepTitle(step: AuthStepSummary): string {
  return step.title ?? DEFAULT_TITLE[step.kind];
}

function StepRail({ steps, activeIndex }: { steps: AuthStepSummary[]; activeIndex: number }) {
  return (
    <ol className="hidden w-52 shrink-0 flex-col gap-3 lg:flex">
      {steps.map((step, i) => {
        const state: StepState = step.satisfied
          ? "done"
          : i === activeIndex
            ? "current"
            : "upcoming";
        return (
          <li
            key={step.index}
            aria-current={state === "current" ? "step" : undefined}
            className="flex items-start gap-2"
          >
            <StepMarker state={state} ordinal={i + 1} />
            <span
              className={cn(
                "text-sm leading-5",
                state === "upcoming" ? "text-muted-foreground" : "text-foreground",
                state === "current" && "font-medium"
              )}
            >
              {stepTitle(step)}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function StepProgress({ steps, activeIndex }: { steps: AuthStepSummary[]; activeIndex: number }) {
  const done = activeIndex;
  return (
    <div className="flex flex-col gap-1.5 lg:hidden">
      <p className="text-xs text-muted-foreground">
        Step {activeIndex + 1} of {steps.length}
      </p>
      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={steps.length}
        aria-valuenow={done}
        aria-label="Setup progress"
        className="h-1 w-full overflow-hidden rounded-full bg-muted"
      >
        <div
          className="h-full bg-foreground transition-[width] duration-200 motion-reduce:transition-none"
          style={{ width: `${(done / steps.length) * 100}%` }}
        />
      </div>
    </div>
  );
}

function Field({
  field,
  value,
  invalid,
  onChange,
}: {
  field: RequiredEnvVar;
  value: string;
  invalid: boolean;
  onChange: (v: string) => void;
}) {
  const id = `auth-field-${field.name}`;
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const hasHint = Boolean(field.description) || (field.steps?.length ?? 0) > 0;
  const describedBy = [hasHint ? hintId : null, invalid ? errorId : null].filter(Boolean).join(" ");
  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-sm font-medium text-foreground" htmlFor={id}>
        {field.label}
      </label>
      {hasHint && (
        <div id={hintId} className="flex flex-col gap-1 text-xs text-muted-foreground">
          {field.description && <p>{field.description}</p>}
          {field.steps?.map((s) => (
            <p key={s}>{s}</p>
          ))}
        </div>
      )}
      <Input
        id={id}
        name={field.name}
        type={field.secret ? "password" : "text"}
        value={value}
        autoComplete="off"
        spellCheck={false}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy || undefined}
        className={cn("font-mono text-sm", invalid && "border-destructive")}
        onChange={(e) => onChange(e.target.value)}
      />
      {invalid && (
        <p id={errorId} className="text-xs text-destructive">
          {field.label} is required.
        </p>
      )}
      {field.setup_url && (
        <a
          href={field.setup_url}
          target="_blank"
          rel="noreferrer"
          className="inline-flex w-fit items-center gap-1 text-xs text-primary underline underline-offset-2 hover:opacity-80"
        >
          Where to find this
          <ExternalLink className="size-3" aria-hidden />
        </a>
      )}
    </div>
  );
}

function ActiveStep({
  slug,
  providerLabel,
  step,
  onAdvance,
  onLocalAdvance,
  calloutError,
}: {
  slug: string;
  providerLabel: string;
  step: AuthStepSummary;
  onAdvance: () => void;
  /** Moves past a step whose completion the server cannot observe. */
  onLocalAdvance: () => void;
  calloutError?: string;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [blank, setBlank] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [org, setOrg] = useState("");

  async function submitFields(e: React.FormEvent) {
    e.preventDefault();
    const fields = step.fields ?? [];
    const empty = fields.filter((f) => !(values[f.name] ?? "").trim()).map((f) => f.name);
    if (empty.length > 0) {
      setBlank(empty);
      document.getElementById(`auth-field-${empty[0]}`)?.focus();
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      await connectIntegration(
        slug,
        Object.fromEntries(fields.map((f) => [f.name, (values[f.name] ?? "").trim()]))
      );
      onAdvance();
    } catch (err) {
      setError(errMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function handoff() {
    setBusy(true);
    setError(undefined);
    try {
      const outcome = await startHandoff(
        slug,
        step.index,
        !step.producesEnv,
        org.trim() || undefined
      );
      if (outcome === "completed") {
        onAdvance();
        setBusy(false);
        return;
      }
      if (step.producesEnv) return; // Navigating away; `busy` stays set so the button cannot flick back.
      onLocalAdvance();
      setBusy(false);
    } catch (err) {
      setError(errMessage(err));
      setBusy(false);
    }
  }

  const shownError = error ?? calloutError;

  return (
    <>
      <div className="flex flex-col gap-1">
        <h3 className="font-medium text-foreground text-sm">{stepTitle(step)}</h3>
        {step.description && <p className="text-muted-foreground text-sm">{step.description}</p>}
      </div>

      {shownError && (
        <p role="alert" className="text-destructive text-sm">
          {shownError}
        </p>
      )}

      {step.kind === "fields" ? (
        <form className="flex flex-col gap-4" onSubmit={submitFields} noValidate>
          {step.fields?.map((field) => (
            <Field
              key={field.name}
              field={field}
              value={values[field.name] ?? ""}
              invalid={blank.includes(field.name)}
              onChange={(v) => {
                setValues((prev) => ({ ...prev, [field.name]: v }));
                setBlank((prev) => prev.filter((n) => n !== field.name));
              }}
            />
          ))}
          <div>
            <Button type="submit" disabled={busy}>
              {busy ? "Saving…" : "Save and continue"}
            </Button>
          </div>
        </form>
      ) : (
        <div className="flex flex-col gap-4">
          {step.kind === "app_manifest" && step.supportsOrgTarget && (
            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-medium text-foreground" htmlFor="auth-org-target">
                Organization (optional)
              </label>
              <p className="text-xs text-muted-foreground">
                Leave blank to create the app under your personal account, or enter an organization
                login to create it there instead.
              </p>
              <Input
                id="auth-org-target"
                name="org"
                type="text"
                value={org}
                autoComplete="off"
                spellCheck={false}
                placeholder="e.g. acme-corp"
                className="max-w-xs font-mono text-sm"
                onChange={(e) => setOrg(e.target.value)}
              />
            </div>
          )}
          <div>
            <Button type="button" disabled={busy} onClick={handoff}>
              {busy
                ? step.kind === "webhook"
                  ? "Registering…"
                  : "Opening…"
                : `${HANDOFF_VERB[step.kind]} ${providerLabel}`}
              {/* No external-link affordance for a step that never leaves the app. */}
              {step.kind !== "webhook" && <ExternalLink aria-hidden />}
            </Button>
          </div>
        </div>
      )}
    </>
  );
}

export function IntegrationAuthFlow({
  slug,
  providerLabel,
  steps,
  onAdvance,
  calloutError,
}: {
  slug: string;
  providerLabel: string;
  steps: AuthStepSummary[];
  onAdvance: () => void;
  calloutError?: string;
}) {
  /*
   * `satisfied` cannot carry that on its own: a step that writes no connection env is satisfied
   * from the moment it is declared, so trusting it would silently skip Slack's "create the app"
   * — the step that hands over the prefilled manifest, and the one thing that flow exists to
   * do.
   */
  const lastProven = steps.reduce((acc, s, i) => (s.satisfied && s.producesEnv ? i : acc), -1);
  const floor = lastProven + 1;
  const [localCursor, setLocalCursor] = useState(floor);
  const cursor = Math.max(localCursor, floor);
  const active = steps[cursor];
  if (!active) return null;

  return (
    <div className="flex flex-col gap-4 lg:flex-row lg:gap-8">
      <StepRail steps={steps} activeIndex={cursor} />
      <div className="flex min-w-0 flex-1 flex-col gap-4">
        <StepProgress steps={steps} activeIndex={cursor} />
        {/* Keyed by step: advancing remounts, which drops the previous step's typing and errors. */}
        <ActiveStep
          key={cursor}
          slug={slug}
          providerLabel={providerLabel}
          step={active}
          onAdvance={onAdvance}
          onLocalAdvance={() => setLocalCursor(cursor + 1)}
          calloutError={calloutError}
        />
      </div>
    </div>
  );
}
