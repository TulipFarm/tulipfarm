import { useLoaderData, useRevalidator, useRouteError } from "@remix-run/react";
import { useState } from "react";
import { FormStatus } from "~/components/form-status";
import { ModelChains } from "~/components/model-chains";
import { ProviderCredentials } from "~/components/model-chains/provider-credentials";
import { ErrorState } from "~/components/states";
import { ApiError } from "~/lib/api";
import {
  getLlmConfig,
  getProviderConfig,
  type LlmConfig,
  listProviders,
  listSecrets,
  putLlmConfig,
} from "~/lib/settings";
import { useIsAdmin } from "~/lib/use-session-user";

export async function clientLoader() {
  const [config, secrets, providers, providerConfig] = await Promise.all([
    getLlmConfig(),
    listSecrets(),
    listProviders(),
    getProviderConfig(),
  ]);
  return { config, providers, secretKeys: secrets.map((s) => s.key), providerConfig };
}

function errorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 403) return "Only an admin can change which models this workspace uses.";
    return err.message; // 422 carries the validation detail
  }
  return err instanceof Error ? err.message : "Request failed.";
}

export default function BusinessModels() {
  const { config, providers, secretKeys, providerConfig } = useLoaderData<typeof clientLoader>();
  const isAdmin = useIsAdmin();
  const revalidator = useRevalidator();
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
    <div className="space-y-4">
      {!isAdmin ? (
        <FormStatus tone="error">
          You can see this configuration but only an admin can change it.
        </FormStatus>
      ) : null}
      {saved ? <FormStatus tone="success">Saved. The LLM service reloaded.</FormStatus> : null}
      <ProviderCredentials
        providers={providers}
        secretKeys={secretKeys}
        config={providerConfig}
        isAdmin={isAdmin}
        onSaved={() => revalidator.revalidate()}
      />
      <ModelChains
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
  return <ErrorState section="business" status={status} message={message} />;
}
