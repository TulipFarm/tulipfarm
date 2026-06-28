import { type FormEvent, useState } from "react";
import { Button } from "~/components/ui/button";
import {
  isProviderConfigured,
  type LlmConfig,
  type LlmProviderInfo,
  type ModelSpec,
  resolveModelSpec,
} from "~/lib/settings";

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

type SpecState = "loading" | "matched" | "unmatched" | "error";
type Row = {
  provider: string;
  model: string;
  uid: number;
  spec?: ModelSpec;
  specState?: SpecState;
};
type Tiers = Record<TierName, Row[]>;

let nextUid = 0;

function cloneTiers(config: LlmConfig): Tiers {
  const rows = (ps: { provider: string; model: string; spec?: ModelSpec }[]): Row[] =>
    ps.map((p) => ({
      provider: p.provider,
      model: p.model,
      uid: nextUid++,
      spec: p.spec,
      specState: p.spec ? ("matched" as const) : undefined,
    }));
  return {
    quick: rows(config.tiers.quick.providers),
    standard: rows(config.tiers.standard.providers),
    complex: rows(config.tiers.complex.providers),
  };
}

const perMtok = (n?: number): string => (n != null ? `$${(n * 1_000_000).toFixed(2)}` : "—");

/** One-line spec summary: cost per Mtok · context · capabilities. */
function specSummary(spec: ModelSpec): string {
  const cost = `${perMtok(spec.input_cost_per_token)} / ${perMtok(spec.output_cost_per_token)} per Mtok`;
  const ctx = spec.max_input_tokens ? ` · ${Math.round(spec.max_input_tokens / 1000)}k ctx` : "";
  const caps = [
    spec.supports_function_calling && "tools",
    spec.supports_vision && "vision",
    spec.supports_prompt_caching && "cache",
    spec.supports_reasoning && "reasoning",
  ]
    .filter(Boolean)
    .join(", ");
  const dep = spec.deprecation_date ? ` · deprecates ${spec.deprecation_date}` : "";
  return `${cost}${ctx}${caps ? ` · ${caps}` : ""}${dep}`;
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

  // Patch by stable uid (not positional index): safe to call after an `await`, when rows may have
  // been added/removed/reordered. `where` optionally guards the write so a stale async result is
  // dropped if the row's provider/model changed while the request was in flight.
  function patchRowByUid(
    tier: TierName,
    uid: number,
    patch: Partial<Row>,
    where?: (r: Row) => boolean
  ) {
    setTiers((prev) => ({
      ...prev,
      [tier]: prev[tier].map((r) =>
        r.uid === uid && (!where || where(r)) ? { ...r, ...patch } : r
      ),
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

  // Resolve the model's spec (pricing/context/capabilities) from LiteLLM and pin it to the row. The
  // spec is persisted with the config on Save, so cost tracking works for this model. Keyed by uid +
  // an equality guard so an in-flight result never lands on a row whose provider/model has changed
  // (which would pin a wrong price). `refresh` re-fetches the LiteLLM catalog (vs the server cache).
  async function fetchSpec(tier: TierName, idx: number) {
    const row = tiers[tier][idx];
    if (!row.provider || !row.model.trim()) return;
    const { uid, provider } = row;
    const model = row.model.trim();
    const stillTarget = (r: Row) => r.provider === provider && r.model.trim() === model;
    const wasRefresh = !!row.spec;
    patchRowByUid(tier, uid, { specState: "loading" });
    try {
      const res = await resolveModelSpec(provider, model, wasRefresh);
      patchRowByUid(
        tier,
        uid,
        { spec: res.spec ?? undefined, specState: res.spec ? "matched" : "unmatched" },
        stillTarget
      );
    } catch {
      patchRowByUid(tier, uid, { specState: "error" }, stillTarget);
    }
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
      rows.map((r) => ({
        provider: r.provider.trim(),
        model: r.model.trim(),
        ...(r.spec ? { spec: r.spec } : {}),
      }));
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
              className="flex flex-col gap-2 border-t border-border pt-3 first:border-t-0 first:pt-0"
            >
              <div className="grid grid-cols-1 items-end gap-2 sm:grid-cols-[1fr_1fr_auto]">
                <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                  provider
                  <select
                    className={inputClass}
                    value={r.provider}
                    // Changing provider invalidates any pinned spec (it was resolved for the old one).
                    onChange={(e) =>
                      patchRow(tier, idx, {
                        provider: e.target.value,
                        spec: undefined,
                        specState: undefined,
                      })
                    }
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
                    // Changing the model invalidates any pinned spec.
                    onChange={(e) =>
                      patchRow(tier, idx, {
                        model: e.target.value,
                        spec: undefined,
                        specState: undefined,
                      })
                    }
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

              {/* Spec resolution: pricing/context/capabilities pinned from LiteLLM. */}
              <div className="flex items-center gap-3 text-xs">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="cursor-pointer rounded-sm"
                  disabled={!r.provider || !r.model.trim() || r.specState === "loading"}
                  onClick={() => fetchSpec(tier, idx)}
                >
                  {r.specState === "loading"
                    ? "Resolving…"
                    : r.spec
                      ? "Refresh spec"
                      : "Fetch spec"}
                </Button>
                {r.spec ? (
                  <span className="truncate text-muted-foreground" title={specSummary(r.spec)}>
                    {specSummary(r.spec)}
                  </span>
                ) : r.specState === "unmatched" ? (
                  <span className="text-muted-foreground">
                    No LiteLLM match — cost stays unpriced (enter pricing_overrides in config, or it
                    just won&rsquo;t show cost).
                  </span>
                ) : r.specState === "error" ? (
                  <span className="text-destructive">Couldn&rsquo;t reach the model catalog.</span>
                ) : (
                  <span className="text-muted-foreground">
                    Spec auto-resolves from LiteLLM on Save (or fetch now to preview).
                  </span>
                )}
              </div>
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
