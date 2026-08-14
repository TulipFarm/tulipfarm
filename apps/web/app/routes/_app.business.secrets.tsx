import { useLoaderData, useRevalidator, useRouteError } from "@remix-run/react";
import { ChevronRight, Trash2 } from "lucide-react";
import { type FormEvent, useMemo, useState } from "react";
import { FormStatus } from "~/components/form-status";
import { ErrorState } from "~/components/states";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Field } from "~/components/ui/field";
import { Input } from "~/components/ui/input";
import { ConfirmModal } from "~/components/ui/modal";
import { Panel, PanelEmpty } from "~/components/ui/panel";
import { Select } from "~/components/ui/select";
import { ApiError } from "~/lib/api";
import {
  deleteSecret,
  getProviderConfig,
  type LlmProviderInfo,
  listProviders,
  listSecrets,
  putSecret,
} from "~/lib/settings";
import { useIsAdmin } from "~/lib/use-session-user";
import { cn } from "~/lib/utils";

const CUSTOM = "__custom__";

type ProviderField = LlmProviderInfo["fields"][number];

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
    if (err.status === 403) return "Only an admin can change secrets.";
    return err.message;
  }
  return err instanceof Error ? err.message : "Request failed.";
}

export default function BusinessSecrets() {
  const { secrets, providers, config } = useLoaderData<typeof clientLoader>();
  const isAdmin = useIsAdmin();
  const revalidator = useRevalidator();
  const storedKeys = useMemo(() => new Set(secrets.map((s) => s.key)), [secrets]);

  const [providerId, setProviderId] = useState(providers[0]?.id ?? CUSTOM);
  // Id of the configured provider whose editor is open (null = all collapsed).
  const [openId, setOpenId] = useState<string | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [customKey, setCustomKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<{
    label: string;
    fn: () => Promise<unknown>;
  } | null>(null);

  // A provider with any stored field is managed from its own row; the add picker only offers ones
  // with nothing set yet, so an existing provider cannot be added twice.
  const unconfiguredProviders = providers.filter(
    (p) => !p.fields.some((f) => storedKeys.has(f.key))
  );
  // Keep the add-form selection valid even if `providerId` went stale (its provider got configured).
  const addProviderId =
    providerId === CUSTOM || unconfiguredProviders.some((p) => p.id === providerId)
      ? providerId
      : (unconfiguredProviders[0]?.id ?? CUSTOM);
  const adding = providers.find((p) => p.id === addProviderId);

  const providerGroups = providers
    .map((p) => ({
      provider: p,
      keys: p.fields.map((f) => f.key).filter((k) => storedKeys.has(k)),
    }))
    .filter((g) => g.keys.length > 0);
  const ownedKeys = new Set(providers.flatMap((p) => p.fields.map((f) => f.key)));
  const customSecrets = secrets.filter((s) => !ownedKeys.has(s.key));

  const typed = (key: string) => (values[key] ?? "").trim().length > 0;
  const filled = (key: string) => typed(key) || storedKeys.has(key);
  const canAdd = adding
    ? adding.fields.filter((f) => !f.optional).every((f) => typed(f.key))
    : customKey.trim().length > 0 && (values[CUSTOM] ?? "").length > 0;
  // Editing: enabled once a field changed and required fields are satisfied. A stored secret counts
  // as satisfied — leaving it blank keeps it.
  const canSaveEdit = (p: LlmProviderInfo) =>
    p.fields.some((f) => typed(f.key)) &&
    p.fields.filter((f) => !f.optional).every((f) => filled(f.key));

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

  // Persist only the fields actually typed into — blank means keep the current value.
  function saveFields(fields: ProviderField[]) {
    void run(async () => {
      await Promise.all(
        fields.filter((f) => typed(f.key)).map((f) => putSecret(f.key, values[f.key].trim()))
      );
      setValues({});
    });
  }

  function onAddSubmit(e: FormEvent) {
    e.preventDefault();
    if (adding) {
      saveFields(adding.fields);
      return;
    }
    void run(async () => {
      await putSecret(customKey.trim(), values[CUSTOM]);
      setValues({});
      setCustomKey("");
    });
  }

  /* `ownerId` namespaces names; secret values never prefill and blank means keep. */
  const renderField = (field: ProviderField, ownerLabel: string) => {
    const stored = field.kind === "secret" && storedKeys.has(field.key);
    return (
      <Field
        key={field.key}
        label={`${field.label}${field.optional ? " (optional)" : ""}`}
        help={stored ? "Already set. Leave blank to keep it." : field.hint}
      >
        <Input
          type={field.kind === "secret" ? "password" : "text"}
          value={values[field.key] ?? (field.kind === "config" ? (config[field.key] ?? "") : "")}
          onChange={(e) => setValues((prev) => ({ ...prev, [field.key]: e.target.value }))}
          placeholder={field.placeholder ?? (field.kind === "secret" ? "••••••••" : "")}
          aria-label={`${field.label} for ${ownerLabel}`}
          disabled={!isAdmin}
        />
      </Field>
    );
  };

  return (
    <div className="space-y-6">
      {error ? <FormStatus tone="error">{error}</FormStatus> : null}
      {!isAdmin ? (
        <FormStatus tone="error">
          You can see which credentials exist but only an admin can change them.
        </FormStatus>
      ) : null}

      <Panel
        title="Stored credentials"
        description="A value is written once and never read back. To rotate one, enter the new value — there is nothing to reveal."
        flush
      >
        {providerGroups.length === 0 && customSecrets.length === 0 ? (
          <PanelEmpty>Nothing stored yet.</PanelEmpty>
        ) : (
          <ul>
            {providerGroups.map((g) => {
              const open = openId === g.provider.id;
              return (
                <li key={g.provider.id} className="border-b border-border last:border-b-0">
                  <div className="flex items-center gap-3 px-4 py-3">
                    <button
                      type="button"
                      className="flex min-w-0 flex-1 items-center gap-2 rounded-sm text-left focus-visible:-outline-offset-2"
                      aria-expanded={open}
                      aria-label={`Edit ${g.provider.label}`}
                      disabled={busy}
                      onClick={() => {
                        setOpenId(open ? null : g.provider.id);
                        setValues({});
                        setError(null);
                      }}
                    >
                      <ChevronRight
                        aria-hidden="true"
                        className={cn(
                          "size-4 shrink-0 text-muted-foreground transition-transform",
                          open && "rotate-90"
                        )}
                      />
                      <span className="truncate text-sm font-medium text-foreground">
                        {g.provider.label}
                      </span>
                      <Badge variant="success">
                        {g.keys.length} {g.keys.length === 1 ? "field" : "fields"}
                      </Badge>
                    </button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-8 shrink-0 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                      disabled={busy || !isAdmin}
                      aria-label={`Delete ${g.provider.label} credentials`}
                      onClick={() =>
                        setPendingDelete({
                          label: g.provider.label,
                          fn: () => Promise.all(g.keys.map((k) => deleteSecret(k))),
                        })
                      }
                    >
                      <Trash2 aria-hidden />
                    </Button>
                  </div>

                  {open ? (
                    <div className="space-y-4 border-t border-border bg-muted/20 px-4 py-4">
                      {g.provider.fields.map((f) => renderField(f, g.provider.label))}
                      <div className="flex justify-end">
                        <Button
                          size="sm"
                          disabled={busy || !isAdmin || !canSaveEdit(g.provider)}
                          onClick={() => saveFields(g.provider.fields)}
                        >
                          {busy ? "Saving…" : "Save"}
                        </Button>
                      </div>
                    </div>
                  ) : null}
                </li>
              );
            })}

            {customSecrets.map((secret) => (
              <li
                key={secret.key}
                className="flex items-center gap-3 border-b border-border px-4 py-3 last:border-b-0"
              >
                <span className="min-w-0 flex-1 truncate font-mono text-sm text-foreground">
                  {secret.key}
                </span>
                <Badge>{secret.type === "auto-generated" ? "Generated" : "Custom"}</Badge>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-8 shrink-0 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                  disabled={busy || !isAdmin}
                  aria-label={`Delete ${secret.key}`}
                  onClick={() =>
                    setPendingDelete({ label: secret.key, fn: () => deleteSecret(secret.key) })
                  }
                >
                  <Trash2 aria-hidden />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      {isAdmin ? (
        <Panel
          title="Add a credential"
          description="Pick a provider to get its exact fields, or store a custom key for something else."
        >
          <form onSubmit={onAddSubmit} className="space-y-4">
            <Field label="Provider">
              <Select
                value={addProviderId}
                onChange={(e) => {
                  setProviderId(e.target.value);
                  setValues({});
                }}
              >
                {unconfiguredProviders.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
                <option value={CUSTOM}>Custom…</option>
              </Select>
            </Field>

            {adding ? (
              adding.fields.map((field) => renderField(field, adding.label))
            ) : (
              <>
                <Field label="Key" help="The name your configuration refers to this value by.">
                  <Input
                    value={customKey}
                    onChange={(e) => setCustomKey(e.target.value)}
                    placeholder="my-custom-secret"
                    className="font-mono"
                  />
                </Field>
                <Field label="Value">
                  <Input
                    type="password"
                    value={values[CUSTOM] ?? ""}
                    onChange={(e) => setValues((prev) => ({ ...prev, [CUSTOM]: e.target.value }))}
                    placeholder="••••••••"
                  />
                </Field>
              </>
            )}

            <div className="flex justify-end">
              <Button type="submit" size="sm" disabled={busy || !canAdd}>
                {busy ? "Saving…" : "Save credential"}
              </Button>
            </div>
          </form>
        </Panel>
      ) : null}

      <ConfirmModal
        open={pendingDelete !== null}
        onClose={() => setPendingDelete(null)}
        onConfirm={() => {
          const pending = pendingDelete;
          setPendingDelete(null);
          if (pending) void run(pending.fn);
        }}
        title="Delete credentials"
        description={`Remove all stored secrets for "${pendingDelete?.label ?? ""}"? Anything using them stops working. This cannot be undone.`}
        busy={busy}
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
