import { useLoaderData, useRevalidator, useRouteError } from "@remix-run/react";
import { type FormEvent, useMemo, useState } from "react";
import { ErrorState } from "~/components/states";
import { Button } from "~/components/ui/button";
import { ApiError } from "~/lib/api";
import {
  deleteSecret,
  getProviderConfig,
  listProviders,
  listSecrets,
  putSecret,
} from "~/lib/settings";

const inputClass =
  "w-full rounded-sm border border-border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-60";

const CUSTOM = "__custom__";

export async function clientLoader() {
  const [secrets, providers, config] = await Promise.all([
    listSecrets(),
    listProviders(),
    getProviderConfig(),
  ]);
  return { secrets, providers, config };
}

function errorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 403) return "admin only — only admins can change secrets";
    return err.message;
  }
  return err instanceof Error ? err.message : "request failed";
}

export default function SettingsSecrets() {
  const { secrets, providers, config } = useLoaderData<typeof clientLoader>();
  const revalidator = useRevalidator();
  const storedKeys = useMemo(() => new Set(secrets.map((s) => s.key)), [secrets]);

  const [providerId, setProviderId] = useState(providers[0]?.id ?? CUSTOM);
  const [values, setValues] = useState<Record<string, string>>({});
  const [customKey, setCustomKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selected = providers.find((p) => p.id === providerId);

  // One list row per CONFIGURED provider (any of its fields stored); leftover keys not owned by a
  // provider (custom/bootstrap secrets) list individually.
  const providerGroups = providers
    .map((p) => ({
      provider: p,
      keys: p.fields.map((f) => f.key).filter((k) => storedKeys.has(k)),
    }))
    .filter((g) => g.keys.length > 0);
  const ownedKeys = new Set(providers.flatMap((p) => p.fields.map((f) => f.key)));
  const customSecrets = secrets.filter((s) => !ownedKeys.has(s.key));

  const filled = (key: string) => (values[key] ?? "").trim().length > 0 || storedKeys.has(key);
  const canSubmit = selected
    ? selected.fields.filter((f) => !f.optional).every((f) => filled(f.key))
    : customKey.trim().length > 0 && (values[CUSTOM] ?? "").length > 0;

  function setVal(key: string, v: string) {
    setValues((prev) => ({ ...prev, [key]: v }));
  }

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      revalidator.revalidate();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    void run(async () => {
      if (selected) {
        await Promise.all(
          selected.fields
            .filter((f) => (values[f.key] ?? "").trim().length > 0)
            .map((f) => putSecret(f.key, values[f.key].trim()))
        );
      } else {
        await putSecret(customKey.trim(), values[CUSTOM]);
      }
      setValues({});
      setCustomKey("");
    });
  }

  return (
    <div className="flex flex-col gap-6">
      <p className="text-sm text-muted-foreground">Secret values are never shown.</p>

      {error ? (
        <p
          role="alert"
          className="rounded-sm border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {error}
        </p>
      ) : null}

      {providerGroups.length === 0 && customSecrets.length === 0 ? (
        <p className="text-sm text-muted-foreground">No secrets set.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {providerGroups.map((g) => (
            <li key={g.provider.id}>
              <details className="group rounded-sm border border-border">
                <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 [&::-webkit-details-marker]:hidden">
                  <span
                    aria-hidden
                    className="text-primary transition-transform group-open:rotate-90"
                  >
                    ▸
                  </span>
                  <span className="font-medium text-foreground">{g.provider.label}</span>
                  <span className="rounded-sm bg-muted px-1.5 py-0.5 text-xs uppercase tracking-[0.15em] text-muted-foreground">
                    {g.keys.length} {g.keys.length === 1 ? "field" : "fields"}
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="ml-auto rounded-sm"
                    disabled={busy}
                    onClick={(e) => {
                      e.preventDefault();
                      setProviderId(g.provider.id);
                      setValues({});
                    }}
                  >
                    Edit
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="rounded-sm"
                    disabled={busy}
                    onClick={(e) => {
                      e.preventDefault();
                      void run(() => Promise.all(g.keys.map((k) => deleteSecret(k))));
                    }}
                  >
                    Delete
                  </Button>
                </summary>
                <dl className="flex flex-col gap-1 border-t border-border px-3 py-2 text-sm">
                  {g.provider.fields
                    .filter((f) => storedKeys.has(f.key))
                    .map((f) => (
                      <div key={f.key} className="flex gap-2">
                        <dt className="text-muted-foreground">{f.label}</dt>
                        <dd className="text-foreground">
                          {f.kind === "secret" ? "•••••••• (set)" : (config[f.key] ?? "(set)")}
                        </dd>
                      </div>
                    ))}
                </dl>
              </details>
            </li>
          ))}

          {customSecrets.map((secret) => (
            <li
              key={secret.key}
              className="flex items-center gap-2 rounded-sm border border-border px-3 py-2"
            >
              <span aria-hidden className="text-primary">
                ▸
              </span>
              <span className="font-medium text-foreground">{secret.key}</span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="ml-auto rounded-sm"
                disabled={busy}
                onClick={() => void run(() => deleteSecret(secret.key))}
              >
                Delete
              </Button>
            </li>
          ))}
        </ul>
      )}

      <form onSubmit={onSubmit} className="flex flex-col gap-3 rounded-sm border border-border p-4">
        <p className="text-sm font-medium text-foreground">Configure a provider</p>

        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          provider
          <select
            className={inputClass}
            value={providerId}
            onChange={(e) => {
              setProviderId(e.target.value);
              setValues({});
            }}
            aria-label="secret provider"
          >
            {providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
            <option value={CUSTOM}>Custom…</option>
          </select>
        </label>

        {selected ? (
          selected.fields.map((field) => (
            <label key={field.key} className="flex flex-col gap-1 text-xs text-muted-foreground">
              {field.label}
              {field.optional ? " (optional)" : ""}
              {storedKeys.has(field.key) ? <span className="text-primary"> · set</span> : ""}
              <input
                className={inputClass}
                type={field.kind === "secret" ? "password" : "text"}
                value={
                  values[field.key] ?? (field.kind === "config" ? (config[field.key] ?? "") : "")
                }
                onChange={(e) => setVal(field.key, e.target.value)}
                placeholder={field.placeholder ?? (field.kind === "secret" ? "••••••••" : "")}
                aria-label={`${selected.id} ${field.role}`}
              />
            </label>
          ))
        ) : (
          <>
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">
              key
              <input
                className={inputClass}
                value={customKey}
                onChange={(e) => setCustomKey(e.target.value)}
                placeholder="my-custom-secret"
                aria-label="secret key"
              />
            </label>
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">
              value
              <input
                className={inputClass}
                type="password"
                value={values[CUSTOM] ?? ""}
                onChange={(e) => setVal(CUSTOM, e.target.value)}
                placeholder="••••••••"
                aria-label="secret value"
              />
            </label>
          </>
        )}

        <div className="flex justify-end">
          <Button type="submit" size="sm" className="rounded-sm" disabled={busy || !canSubmit}>
            {busy ? "Saving…" : "Save provider"}
          </Button>
        </div>
      </form>
    </div>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();
  const status = error instanceof ApiError ? error.status : undefined;
  const message = error instanceof Error ? error.message : undefined;
  return <ErrorState section="settings" status={status} message={message} />;
}
