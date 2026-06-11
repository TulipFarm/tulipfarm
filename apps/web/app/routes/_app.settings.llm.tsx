import { useLoaderData, useRevalidator, useRouteError } from "@remix-run/react";
import { useState } from "react";
import { LlmConfigForm } from "~/components/llm-config-form";
import { ErrorState } from "~/components/states";
import { ApiError } from "~/lib/api";
import {
  getLlmConfig,
  isProviderConfigured,
  type LlmConfig,
  listProviders,
  listSecrets,
  putLlmConfig,
} from "~/lib/settings";

export async function clientLoader() {
  const [config, secrets, providers] = await Promise.all([
    getLlmConfig(),
    listSecrets(),
    listProviders(),
  ]);
  return { config, providers, secretKeys: secrets.map((s) => s.key) };
}

function errorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 403) return "admin only — only admins can change the LLM config";
    return err.message; // 422 carries the validation detail
  }
  return err instanceof Error ? err.message : "request failed";
}

export default function SettingsLlm() {
  const { config, providers, secretKeys } = useLoaderData<typeof clientLoader>();
  const revalidator = useRevalidator();
  // True when no provider is fully configured yet — nudge the operator to the Secrets tab.
  const noneEnabled =
    providers.length > 0 && !providers.some((p) => isProviderConfigured(p, secretKeys));
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function onSubmit(next: LlmConfig) {
    setSubmitting(true);
    setFormError(null);
    setSaved(false);
    try {
      await putLlmConfig(next);
      setSaved(true);
      revalidator.revalidate();
    } catch (err) {
      setFormError(errorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        <span aria-hidden className="text-primary">
          ${" "}
        </span>
        tulipfarm llm-config · tiers run their providers as a fallback chain (top first)
      </p>
      {noneEnabled ? (
        <p className="rounded-sm border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
          No provider secrets yet — add one in the <span className="text-foreground">Secrets</span>{" "}
          tab to enable a provider here.
        </p>
      ) : null}
      {saved ? <p className="text-sm text-primary">Saved · LLM service reloaded.</p> : null}
      <LlmConfigForm
        initial={config}
        providers={providers}
        secretKeys={secretKeys}
        onSubmit={onSubmit}
        submitting={submitting}
        formError={formError}
      />
    </div>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();
  const status = error instanceof ApiError ? error.status : undefined;
  const message = error instanceof Error ? error.message : undefined;
  return (
    <ErrorState
      section="settings"
      command="tulipfarm llm-config"
      status={status}
      message={message}
    />
  );
}
