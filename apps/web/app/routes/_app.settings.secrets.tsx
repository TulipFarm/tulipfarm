import { useLoaderData, useRevalidator, useRouteError } from "@remix-run/react";
import { type FormEvent, useMemo, useState } from "react";
import { ErrorState } from "~/components/states";
import { Button } from "~/components/ui/button";
import { ConfirmModal } from "~/components/ui/modal";
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
  // Id of the configured provider whose inline editor is open (null = all collapsed).
  const [openId, setOpenId] = useState<string | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [customKey, setCustomKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<{
    label: string;
    fn: () => Promise<unknown>;
  } | null>(null);

  // A provider with any stored field is managed (edited/deleted) from its own list row; the "Add a
  // provider" picker below only offers ones with nothing set yet, so you can't re-add an existing one.
  const unconfiguredProviders = providers.filter(
    (p) => !p.fields.some((f) => storedKeys.has(f.key))
  );
  // Keep the add-form selection valid even if `providerId` went stale (its provider got configured).
  // CUSTOM is always a valid selection — it's not a member of `unconfiguredProviders`, which only
  // ever holds real providers from the API.
  const addProviderId =
    providerId === CUSTOM || unconfiguredProviders.some((p) => p.id === providerId)
      ? providerId
      : (unconfiguredProviders[0]?.id ?? CUSTOM);
  const adding = providers.find((p) => p.id === addProviderId);

  // One list row per CONFIGURED provider (any of its fields stored); leftover keys not owned by a
  // provider (custom/bootstrap env config) list individually.
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
  // Adding a new provider needs every required field actually typed (nothing is stored yet).
  const canAdd = adding
    ? adding.fields.filter((f) => !f.optional).every((f) => typed(f.key))
    : customKey.trim().length > 0 && (values[CUSTOM] ?? "").length > 0;
  // Editing an existing provider: enabled once a field was changed and required fields are satisfied
  // (a stored secret counts as satisfied — leaving it blank keeps it).
  const canSaveEdit = (p: (typeof providers)[number]) =>
    p.fields.some((f) => typed(f.key)) &&
    p.fields.filter((f) => !f.optional).every((f) => filled(f.key));

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

  // Persist only the fields the user actually typed into (blank = keep current value). Shared by the
  // inline edit rows and the add form.
  function saveFields(fields: { key: string }[]) {
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

  // A provider field input + label. `ownerId` namespaces the aria-label so two providers with a same-
  // role field don't collide. Secret values are never returned by the API, so a stored secret renders
  // as a blank field with a "leave blank to keep" hint; config values (e.g. resource name) prefill.
  const renderField = (field: (typeof providers)[number]["fields"][number], ownerId: string) => (
    <label key={field.key} className="flex flex-col gap-1 text-xs text-muted-foreground">
      <span>
        {field.label}
        {field.optional ? " (optional)" : ""}
        {field.kind === "secret" && storedKeys.has(field.key) ? " — set, leave blank to keep" : ""}
      </span>
      <input
        className={inputClass}
        type={field.kind === "secret" ? "password" : "text"}
        value={values[field.key] ?? (field.kind === "config" ? (config[field.key] ?? "") : "")}
        onChange={(e) => setVal(field.key, e.target.value)}
        placeholder={field.placeholder ?? (field.kind === "secret" ? "••••••••" : "")}
        aria-label={`${ownerId} ${field.role}`}
      />
    </label>
  );

  return (
    <div className="flex flex-col gap-6">
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
          {providerGroups.map((g) => {
            const open = openId === g.provider.id;
            return (
              <li key={g.provider.id} className="rounded-sm border border-border">
                <div className="flex items-center gap-2 px-3 py-2">
                  <span
                    aria-hidden
                    className={`text-primary transition-transform ${open ? "rotate-90" : ""}`}
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
                    className="ml-auto cursor-pointer rounded-sm"
                    disabled={busy}
                    onClick={() => {
                      setOpenId(open ? null : g.provider.id);
                      setValues({});
                      setError(null);
                    }}
                  >
                    {open ? "Close" : "Edit"}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="cursor-pointer rounded-sm"
                    disabled={busy}
                    onClick={() =>
                      setPendingDelete({
                        label: g.provider.label,
                        fn: () => Promise.all(g.keys.map((k) => deleteSecret(k))),
                      })
                    }
                  >
                    Delete
                  </Button>
                </div>
                {open ? (
                  <div className="flex flex-col gap-3 border-t border-border px-3 py-3">
                    <p className="text-xs text-muted-foreground">
                      Edit any field, then Save. Secret values are never shown — leave a field blank
                      to keep it.
                    </p>
                    {g.provider.fields.map((f) => renderField(f, g.provider.id))}
                    <div className="flex justify-end">
                      <Button
                        type="button"
                        size="sm"
                        className="cursor-pointer rounded-sm"
                        disabled={busy || !canSaveEdit(g.provider)}
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
                className="ml-auto cursor-pointer rounded-sm"
                disabled={busy}
                onClick={() =>
                  setPendingDelete({
                    label: secret.key,
                    fn: () => deleteSecret(secret.key),
                  })
                }
              >
                Delete
              </Button>
            </li>
          ))}
        </ul>
      )}

      <form
        onSubmit={onAddSubmit}
        className="flex flex-col gap-3 rounded-sm border border-border p-4"
      >
        <p className="text-sm font-medium text-foreground">Add a provider</p>

        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          provider
          <select
            className={inputClass}
            value={addProviderId}
            onChange={(e) => {
              setProviderId(e.target.value);
              setValues({});
            }}
            aria-label="secret provider"
          >
            {unconfiguredProviders.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
            <option value={CUSTOM}>Custom…</option>
          </select>
        </label>

        {adding ? (
          adding.fields.map((field) => renderField(field, adding.id))
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
          <Button
            type="submit"
            size="sm"
            className="cursor-pointer rounded-sm"
            disabled={busy || !canAdd}
          >
            {busy ? "Saving…" : "Save provider"}
          </Button>
        </div>
      </form>

      <ConfirmModal
        open={pendingDelete !== null}
        onClose={() => setPendingDelete(null)}
        onConfirm={() => {
          const pending = pendingDelete;
          setPendingDelete(null);
          if (pending) void run(pending.fn);
        }}
        title="Delete secrets"
        description={`Remove all secrets for "${pendingDelete?.label ?? ""}"? This cannot be undone.`}
        busy={busy}
      />
    </div>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();
  const status = error instanceof ApiError ? error.status : undefined;
  const message = error instanceof Error ? error.message : undefined;
  return <ErrorState section="settings" status={status} message={message} />;
}
