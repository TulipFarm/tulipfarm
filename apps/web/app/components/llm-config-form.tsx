import { type FormEvent, useState } from "react";
import { Button } from "~/components/ui/button";
import { isProviderConfigured, type LlmConfig, type LlmProviderInfo } from "~/lib/settings";

/*
 * Structured editor for soul/llm.config.yaml (UI-V1-003 / LLM-V1-003). Each tier is an ordered list
 * of providers — the order IS the fallback chain. A row is just { provider, model }: a provider's
 * credentials and config (api key, resource_name, base_url) are configured once in the Secrets tab
 * and resolved server-side from the registry, so they are not entered here. A provider is only
 * selectable once it is fully configured. Embeddings are round-tripped untouched.
 */

const TIERS = ["quick", "standard", "complex"] as const;
type TierName = (typeof TIERS)[number];

const inputClass =
  "w-full rounded-sm border border-border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-60";

type Row = { provider: string; model: string; uid: number };
type Tiers = Record<TierName, Row[]>;

let nextUid = 0;

function cloneTiers(config: LlmConfig): Tiers {
  const rows = (ps: { provider: string; model: string }[]): Row[] =>
    ps.map((p) => ({ provider: p.provider, model: p.model, uid: nextUid++ }));
  return {
    quick: rows(config.tiers.quick.providers),
    standard: rows(config.tiers.standard.providers),
    complex: rows(config.tiers.complex.providers),
  };
}

export type LlmConfigFormProps = {
  initial: LlmConfig;
  providers: LlmProviderInfo[];
  secretKeys: string[];
  onSubmit: (config: LlmConfig) => void | Promise<void>;
  submitting: boolean;
  formError?: string | null;
};

export function LlmConfigForm({
  initial,
  providers,
  secretKeys,
  onSubmit,
  submitting,
  formError,
}: LlmConfigFormProps) {
  const [tiers, setTiers] = useState<Tiers>(() => cloneTiers(initial));
  const [localError, setLocalError] = useState<string | null>(null);

  const isEnabled = (p: LlmProviderInfo) => isProviderConfigured(p, secretKeys);
  const known = new Set(providers.map((p) => p.id));
  const firstEnabled = providers.find(isEnabled);

  function patchRow(tier: TierName, idx: number, patch: Partial<Row>) {
    setTiers((prev) => ({
      ...prev,
      [tier]: prev[tier].map((r, i) => (i === idx ? { ...r, ...patch } : r)),
    }));
  }

  function addProvider(tier: TierName) {
    setTiers((prev) => ({
      ...prev,
      [tier]: [...prev[tier], { provider: firstEnabled?.id ?? "", model: "", uid: nextUid++ }],
    }));
  }

  function removeProvider(tier: TierName, idx: number) {
    setTiers((prev) => ({ ...prev, [tier]: prev[tier].filter((_, i) => i !== idx) }));
  }

  // Block submit on a row whose provider is known but not fully configured (its secret/config was
  // removed) — the backend would fail to build it. Returns the first problem, or null.
  function validate(): string | null {
    for (const tier of TIERS) {
      if (tiers[tier].length === 0) return `The ${tier} tier needs at least one provider.`;
      for (const r of tiers[tier]) {
        if (!r.provider) return `Pick a provider for every row in the ${tier} tier.`;
        const info = providers.find((p) => p.id === r.provider);
        if (info && !isEnabled(info)) {
          return `${info.label} is not fully configured — set it up in the Secrets tab.`;
        }
        if (!r.model.trim()) return `Set a model for every provider in the ${tier} tier.`;
      }
    }
    return null;
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const problem = validate();
    setLocalError(problem);
    if (problem) return;
    const toEntries = (rows: Row[]) =>
      rows.map((r) => ({ provider: r.provider.trim(), model: r.model.trim() }));
    const config: LlmConfig = {
      tiers: {
        quick: { providers: toEntries(tiers.quick) },
        standard: { providers: toEntries(tiers.standard) },
        complex: { providers: toEntries(tiers.complex) },
      },
      ...(initial.embeddings ? { embeddings: initial.embeddings } : {}),
    };
    void onSubmit(config);
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-6">
      {(formError ?? localError) ? (
        <p
          role="alert"
          className="rounded-sm border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {formError ?? localError}
        </p>
      ) : null}

      {TIERS.map((tier) => (
        <fieldset key={tier} className="flex flex-col gap-3 rounded-sm border border-border p-4">
          <legend className="px-1 text-xs uppercase tracking-[0.2em] text-muted-foreground">
            <span className="text-primary">[</span>
            {tier}
            <span className="text-primary">]</span>
          </legend>

          {tiers[tier].map((r, idx) => (
            <div
              key={r.uid}
              className="grid grid-cols-1 items-end gap-2 border-t border-border pt-3 first:border-t-0 first:pt-0 sm:grid-cols-[1fr_1fr_auto]"
            >
              <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                provider
                <select
                  className={inputClass}
                  value={r.provider}
                  onChange={(e) => patchRow(tier, idx, { provider: e.target.value })}
                  aria-label={`${tier} provider ${idx + 1} provider`}
                >
                  {r.provider && !known.has(r.provider) ? (
                    <option value={r.provider}>{r.provider}</option>
                  ) : null}
                  {providers.map((p) => (
                    <option key={p.id} value={p.id} disabled={!isEnabled(p)}>
                      {p.label}
                      {isEnabled(p) ? "" : " — configure first"}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                model
                <input
                  className={inputClass}
                  value={r.model}
                  onChange={(e) => patchRow(tier, idx, { model: e.target.value })}
                  placeholder="claude-sonnet-4-6"
                  aria-label={`${tier} provider ${idx + 1} model`}
                />
              </label>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="rounded-sm"
                disabled={tiers[tier].length <= 1}
                onClick={() => removeProvider(tier, idx)}
              >
                Remove
              </Button>
            </div>
          ))}

          <div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="rounded-sm"
              onClick={() => addProvider(tier)}
            >
              + Add provider
            </Button>
          </div>
        </fieldset>
      ))}

      <div className="flex justify-end">
        <Button type="submit" size="sm" className="rounded-sm" disabled={submitting}>
          {submitting ? "Saving…" : "Save"}
        </Button>
      </div>
    </form>
  );
}
