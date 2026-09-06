import { useState } from "react";
import { ChevronRight, Trash2 } from "~/components/icons";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Field } from "~/components/ui/field";
import { Input } from "~/components/ui/input";
import { ConfirmModal } from "~/components/ui/modal";
import { Panel } from "~/components/ui/panel";
import { deleteSecret, type LlmProviderInfo, putSecret } from "~/lib/settings";
import { cn } from "~/lib/utils";

type ProviderField = LlmProviderInfo["fields"][number];

/**
 * Credential entry for LLM providers, surfaced directly on the model settings page so a first-time
 * operator never has to leave it for the Secrets page to unblock a model choice. The Secrets page
 * keeps its own full copy of this same list; this is an additional entry point, not a move — both
 * write through the same `putSecret` path, so either one immediately unblocks the other.
 */
export function ProviderCredentials({
  providers,
  secretKeys,
  config,
  isAdmin,
  onSaved,
}: {
  providers: LlmProviderInfo[];
  secretKeys: string[];
  config: Record<string, string>;
  isAdmin: boolean;
  onSaved: () => void;
}) {
  const storedKeys = new Set(secretKeys);
  const [openId, setOpenId] = useState<string | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<LlmProviderInfo | null>(null);

  const typed = (key: string) => (values[key] ?? "").trim().length > 0;
  const filled = (key: string) => typed(key) || storedKeys.has(key);
  const canSave = (p: LlmProviderInfo) =>
    p.fields.some((f) => typed(f.key)) &&
    p.fields.filter((f) => !f.optional).every((f) => filled(f.key));

  function save(p: LlmProviderInfo) {
    setBusy(true);
    setError(null);
    void Promise.all(
      p.fields.filter((f) => typed(f.key)).map((f) => putSecret(f.key, values[f.key].trim()))
    )
      .then(() => {
        setValues({});
        onSaved();
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : "Request failed.");
      })
      .finally(() => setBusy(false));
  }

  function removeCredentials(p: LlmProviderInfo) {
    setBusy(true);
    setError(null);
    void Promise.all(p.fields.filter((f) => storedKeys.has(f.key)).map((f) => deleteSecret(f.key)))
      .then(() => {
        setPendingDelete(null);
        onSaved();
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : "Request failed.");
      })
      .finally(() => setBusy(false));
  }

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
    <Panel
      title="Providers & credentials"
      description="Every model on this page runs through one of these. Add the credential a provider needs, then pick its models below."
      flush
    >
      {error ? (
        <p role="alert" className="mx-4 mt-4 text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <ul>
        {providers.map((p) => {
          const configured = p.fields
            .filter((f) => !f.optional)
            .every((f) => storedKeys.has(f.key));
          const open = openId === p.id;
          return (
            <li
              key={p.id}
              className="flex items-center gap-1 border-b border-border last:border-b-0"
            >
              <div className="flex-1">
                <button
                  type="button"
                  className="flex min-h-7 w-full items-center gap-2 px-4 py-3 text-left focus-visible:-outline-offset-2"
                  aria-expanded={open}
                  aria-label={`Edit ${p.label} credentials`}
                  onClick={() => {
                    setOpenId(open ? null : p.id);
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
                  <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
                    {p.label}
                  </span>
                  <Badge variant={configured ? "success" : "warning"}>
                    {configured ? "Configured" : "Not set"}
                  </Badge>
                </button>

                {open ? (
                  <div className="space-y-4 border-t border-border bg-muted/20 px-4 py-4">
                    {p.fields.map((f) => renderField(f, p.label))}
                    <div className="flex justify-end">
                      <Button
                        size="sm"
                        disabled={busy || !isAdmin || !canSave(p)}
                        onClick={() => save(p)}
                      >
                        {busy ? "Saving…" : "Save"}
                      </Button>
                    </div>
                  </div>
                ) : null}
              </div>
              <div className="mr-2 size-8 shrink-0">
                {configured ? (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-8 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                    disabled={busy || !isAdmin}
                    aria-label={`Delete ${p.label} credentials`}
                    onClick={() => setPendingDelete(p)}
                  >
                    <Trash2 aria-hidden />
                  </Button>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>

      <ConfirmModal
        open={pendingDelete !== null}
        onClose={() => setPendingDelete(null)}
        onConfirm={() => pendingDelete && removeCredentials(pendingDelete)}
        title="Delete credentials"
        description={`Remove all stored secrets for "${pendingDelete?.label ?? ""}"? Anything using them stops working. This cannot be undone.`}
        busy={busy}
      />
    </Panel>
  );
}
