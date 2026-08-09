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
 * The connect experience for every Integration, driven entirely by the `auth` step list its
 * manifest declares. There is deliberately no branch on the Integration here — adding Telegram or
 * Notion must mean writing a manifest, not editing this file. The only closed vocabularies below
 * are keyed by step *kind*, which is a fixed part of the manifest contract.
 *
 * Two kinds of step exist from the browser's point of view:
 *
 *   - `fields`, which the operator fills in here. Its descriptors arrive with the detail payload,
 *     so the form renders without a round trip and without asking the API to mint a one-use state
 *     it would never spend.
 *   - everything else, which happens at the provider. Those call `POST .../auth/start/:step` at
 *     the moment the operator commits, because that call issues a short-lived one-use state;
 *     issuing one on render would burn a state every time the page is merely looked at.
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
 * Starts one step that does not collect fields, and hands the browser over if the step needs it.
 *
 * Returns `"completed"` when the server finished the step by itself — a `webhook` registration
 * talks to the provider from the API, so there is nothing to navigate to and the caller should
 * just refresh. `"handed_off"` means the page is navigating away or a tab has opened, so callers
 * should leave their pending state set.
 *
 * `newTab` is not cosmetic. A step whose completion writes no connection env gives us no callback
 * to come back on, so navigating away would strand the operator on the provider with no way to
 * report progress. Those open beside the app instead; steps we *can* observe take the tab, because
 * the provider must redirect back into this same top-level context.
 */
export async function startHandoff(
  slug: string,
  stepIndex: number,
  newTab = false
): Promise<"handed_off" | "completed"> {
  const action = await startAuthStep(slug, stepIndex);
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

/** The whole shape of the flow, so the operator can see what they are committing to. Desktop only. */
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

/** Below `lg` the rail would crowd out the form, so the same progress reads as a bar. */
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

/** Owns everything the operator is typing right now. Remounted per step, so nothing leaks across. */
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
      const outcome = await startHandoff(slug, step.index, !step.producesEnv);
      if (outcome === "completed") {
        // The API finished it; re-read the server's view rather than assuming what it wrote.
        onAdvance();
        setBusy(false);
        return;
      }
      if (step.producesEnv) return; // Navigating away; `busy` stays set so the button cannot flick back.
      // Nothing will report this step as finished, so the operator's click is the only signal
      // there will ever be. It opened beside the app, so move on and leave them to it.
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
  /** Display name of the provider, used only in the handoff button's label. */
  providerLabel: string;
  steps: AuthStepSummary[];
  /** Called once a `fields` step is stored, so the route can refetch and advance. */
  onAdvance: () => void;
  /** A failure the provider callback reported on the way back, if any. */
  calloutError?: string;
}) {
  /*
   * A step counts as behind us only if it *proved* it finished. `satisfied` cannot carry that on
   * its own: a step that writes no connection env is satisfied from the moment it is declared, so
   * trusting it would silently skip Slack's "create the app" — the step that hands over the
   * prefilled manifest, and the one thing that flow exists to do.
   */
  const lastProven = steps.reduce((acc, s, i) => (s.satisfied && s.producesEnv ? i : acc), -1);
  const floor = lastProven + 1;
  const [localCursor, setLocalCursor] = useState(floor);
  // Anything the server has since proven wins, so a refetch always pulls the flow forward.
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
