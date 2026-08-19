import { useEffect, useId, useState } from "react";
import { type Row, specFacts } from "~/components/model-chains/chain-data";
import { Button } from "~/components/ui/button";
import { Field } from "~/components/ui/field";
import { Input } from "~/components/ui/input";
import { Select } from "~/components/ui/select";
import { Sheet } from "~/components/ui/sheet";
import {
  getModelOptions,
  isProviderConfigured,
  type LlmProviderInfo,
  type ModelOptions,
  resolveModelSpec,
} from "~/lib/settings";
import { cn } from "~/lib/utils";

const CUSTOM_MODEL = "__custom__";

export function ModelSheet({
  open,
  row,
  providers,
  secretKeys,
  onCancel,
  onDone,
  onChange,
}: {
  open: boolean;
  row: Row | undefined;
  providers: LlmProviderInfo[];
  secretKeys: string[];
  onCancel: () => void;
  onDone: () => void;
  onChange: (patch: Partial<Row>) => void;
}) {
  const [options, setOptions] = useState<ModelOptions | null>(null);
  const [resolving, setResolving] = useState(false);
  const [candidates, setCandidates] = useState<string[]>([]);
  const [unmatched, setUnmatched] = useState(false);
  // Scoped to the row it was raised for, so a newly opened row never inherits it.
  const [errors, setErrors] = useState<{ uid: number; provider?: string; model?: string } | null>(
    null
  );
  const provider = row?.provider;
  const model = row?.model;

  useEffect(() => {
    if (!open || !provider) {
      setOptions(null);
      return;
    }
    let live = true;
    setOptions(null);
    getModelOptions(provider)
      .then((next) => {
        if (live) setOptions(next);
      })
      .catch(() => {
        if (live)
          setOptions({ models: [], source: "unavailable", reason: "Could not reach the API." });
      });
    return () => {
      live = false;
    };
  }, [open, provider]);

  /** Catalogue misses still need a context window so runtime budgeting can work. */
  async function pinSpec(candidate?: string, modelOverride?: string) {
    const targetModel = modelOverride ?? model;
    if (!provider || !targetModel) return;
    setResolving(true);
    try {
      const result = await resolveModelSpec(provider, targetModel, false, candidate);
      if (result.spec) {
        onChange({ spec: result.spec });
        setCandidates([]);
        setUnmatched(false);
      } else if (result.candidates.length > 0) {
        setCandidates(result.candidates);
        setUnmatched(false);
      } else {
        setCandidates([]);
        setUnmatched(true);
      }
    } catch {
      setCandidates([]);
      setUnmatched(true);
    } finally {
      setResolving(false);
    }
  }

  const info = providers.find((p) => p.id === provider);
  const ready = info ? isProviderConfigured(info, secretKeys) : false;
  const facts = specFacts(row?.spec);
  const hasSuggestions = !!options && options.models.length > 0;
  // A suggested id picks the dropdown value directly; anything else (including empty, mid-typing a
  // custom id) falls to the "Custom…" branch so the free-text input stays in control.
  const isSuggested = hasSuggestions && !!row?.model && options.models.includes(row.model);
  const showCustomInput = !hasSuggestions || !isSuggested;
  // The field renders two conditional controls, so `Field` cannot auto-wire its label — it only
  // clones a single child. The id therefore has to be placed by hand, on whichever control the
  // label names: the free-text input when it is showing, otherwise the suggestion dropdown.
  const modelFieldId = useId();
  const modelHelpId = `${modelFieldId}-help`;

  function finish() {
    if (!row) return;
    if (!row.provider.trim()) {
      setErrors({ uid: row.uid, provider: "Select a provider." });
      return;
    }
    if (!row.model.trim()) {
      setErrors({ uid: row.uid, model: "Enter a Model ID." });
      return;
    }
    setErrors(null);
    onDone();
  }

  const shownErrors = errors?.uid === row?.uid ? errors : undefined;

  return (
    <Sheet open={open} onClose={onCancel} title="Model">
      {row ? (
        <div className="space-y-4 p-4">
          <Field
            label="Provider"
            error={shownErrors?.provider}
            help={ready ? undefined : "This provider has no credential yet."}
          >
            <Select
              value={row.provider}
              onChange={(e) => {
                setErrors(null);
                onChange({ provider: e.target.value, model: "", spec: undefined });
              }}
            >
              <option value="">Select a provider…</option>
              {providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                  {isProviderConfigured(p, secretKeys) ? "" : " (no credential)"}
                </option>
              ))}
            </Select>
          </Field>

          <Field
            label="Model ID"
            htmlFor={modelFieldId}
            error={shownErrors?.model}
            help={
              options?.source === "live"
                ? "Listed from your configured endpoint."
                : options?.source === "catalog"
                  ? "Suggested from the model catalog. Any ID your provider accepts will work."
                  : (options?.reason ?? "Enter the ID exactly as your provider spells it.")
            }
          >
            {hasSuggestions ? (
              <Select
                id={showCustomInput ? undefined : modelFieldId}
                aria-label={showCustomInput ? "Model ID suggestions" : undefined}
                aria-describedby={showCustomInput ? undefined : modelHelpId}
                value={isSuggested ? row.model : CUSTOM_MODEL}
                onChange={(e) => {
                  const value = e.target.value;
                  setErrors(null);
                  setCandidates([]);
                  setUnmatched(false);
                  if (value === CUSTOM_MODEL) {
                    onChange({ model: "", spec: undefined });
                    return;
                  }
                  onChange({ model: value, spec: undefined });
                  void pinSpec(undefined, value);
                }}
              >
                {options.models.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
                <option value={CUSTOM_MODEL}>Custom…</option>
              </Select>
            ) : null}
            {showCustomInput ? (
              <Input
                id={modelFieldId}
                aria-describedby={modelHelpId}
                value={row.model}
                onChange={(e) => {
                  onChange({ model: e.target.value, spec: undefined });
                  setErrors(null);
                  setCandidates([]);
                  setUnmatched(false);
                }}
                onBlur={() => {
                  if (row.model.trim() && !row.spec) void pinSpec();
                }}
                placeholder="e.g. gpt-4o-mini"
                className={cn("font-mono", hasSuggestions && "mt-2")}
              />
            ) : null}
          </Field>

          <div className="rounded-md border border-border p-3">
            <div className="flex items-center justify-between gap-3">
              <p className="text-sm font-medium text-foreground">Pricing and limits</p>
              <Button
                variant="outline"
                size="sm"
                onClick={() => void pinSpec()}
                disabled={resolving || !row.model.trim()}
              >
                {resolving ? "Looking up…" : row.spec ? "Refresh" : "Look up"}
              </Button>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              {facts.length > 0
                ? facts.join(" · ")
                : "Not pinned. Costs will be unknown in Observability until you look this up."}
            </p>

            {candidates.length > 0 ? (
              <div className="mt-3 space-y-2">
                <p className="text-xs text-muted-foreground">
                  Several catalogue entries match “{row.model}”. Pick the one you are actually
                  calling.
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {candidates.map((candidate) => (
                    <Button
                      key={candidate}
                      variant="outline"
                      size="sm"
                      className="font-mono text-xs"
                      onClick={() => void pinSpec(candidate)}
                    >
                      {candidate}
                    </Button>
                  ))}
                </div>
              </div>
            ) : null}

            {unmatched ? (
              <div className="mt-3">
                <Field
                  label="Context window"
                  help="Not in the catalogue. Enter the model's max input tokens so the runtime can budget against it."
                >
                  <Input
                    type="number"
                    inputMode="numeric"
                    value={row.spec?.max_input_tokens ?? ""}
                    onChange={(e) => {
                      const parsed = Number.parseInt(e.target.value, 10);
                      onChange({
                        spec: Number.isFinite(parsed) ? { max_input_tokens: parsed } : undefined,
                      });
                    }}
                    placeholder="131072"
                  />
                </Field>
              </div>
            ) : null}
          </div>

          <details className="rounded-md border border-border">
            <summary className="cursor-pointer px-3 py-2 text-sm font-medium text-foreground">
              Connection overrides
            </summary>
            <div className="space-y-3 border-t border-border p-3">
              <Field label="API key reference" help="Leave empty to use the provider default.">
                <Input
                  value={row.api_key_ref ?? ""}
                  onChange={(e) => onChange({ api_key_ref: e.target.value })}
                  className="font-mono"
                />
              </Field>
              <Field label="Base URL" help="Only for self-hosted or proxied endpoints.">
                <Input
                  value={row.base_url ?? ""}
                  onChange={(e) => onChange({ base_url: e.target.value })}
                  className="font-mono"
                />
              </Field>
              <Field label="Resource name" help="Azure deployments only.">
                <Input
                  value={row.resource_name ?? ""}
                  onChange={(e) => onChange({ resource_name: e.target.value })}
                  className="font-mono"
                />
              </Field>
            </div>
          </details>

          <div className={cn("flex justify-end")}>
            <Button size="sm" onClick={finish}>
              Done
            </Button>
          </div>
        </div>
      ) : null}
    </Sheet>
  );
}
