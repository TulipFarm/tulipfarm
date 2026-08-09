import { type FormEvent, useMemo, useState } from "react";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import {
  getModelOptions,
  isProviderConfigured,
  type LlmConfig,
  type LlmProviderInfo,
  type ModelOptions,
  type ModelSpec,
  type ProviderEntry,
  resolveModelSpec,
} from "~/lib/settings";

const CHAIN_CONFIG = [
  {
    tier: "quick",
    preset: "fast",
    label: "Fast",
    description: "Low-latency provider chain for short turns.",
  },
  {
    tier: "standard",
    preset: "balanced",
    label: "Balanced",
    description: "Default everyday provider chain for most Chat turns.",
  },
  {
    tier: "complex",
    preset: "thorough",
    label: "Thorough",
    description: "Deeper reasoning provider chain for harder work.",
  },
] as const;

type TierName = (typeof CHAIN_CONFIG)[number]["tier"];
type PresetTargetKey = "default" | "fast" | "balanced" | "thorough";

const PRESET_FIELDS: { key: PresetTargetKey; label: string; help: string }[] = [
  {
    key: "default",
    label: "Auto default",
    help: "Used when a user just types a message and leaves effort on Auto.",
  },
  { key: "fast", label: "Fast", help: "Profile used when Fast is explicitly selected." },
  {
    key: "balanced",
    label: "Balanced",
    help: "Profile used when Balanced is explicitly selected.",
  },
  {
    key: "thorough",
    label: "Thorough",
    help: "Profile used when Thorough is explicitly selected.",
  },
];

const DEFAULT_PRESETS: Record<PresetTargetKey, string> = {
  default: "balanced",
  fast: "fast",
  balanced: "balanced",
  thorough: "thorough",
};

const inputClass =
  "w-full rounded-sm border border-border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-60";

const subtleInputClass =
  "w-full rounded-sm border border-input bg-background px-2.5 py-1.5 text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-60";

type SpecState = "loading" | "matched" | "manual" | "unmatched" | "error";
type Row = ProviderEntry & {
  uid: number;
  specState?: SpecState;
  specCandidates?: string[];
};
type Tiers = Record<TierName, Row[]>;
type PresetState = Record<PresetTargetKey, string>;

type ProfileOption = {
  id: string;
  label: string;
};

type ConnectionSummary = {
  name: string;
  sharedCount: number;
  details: string[];
};

let nextUid = 0;

function cloneTiers(config: LlmConfig): Tiers {
  const rows = (ps: ProviderEntry[] | undefined): Row[] =>
    (ps ?? []).map((p) => ({
      ...p,
      uid: nextUid++,
      specState:
        p.spec && typeof p.spec.max_input_tokens === "number"
          ? "matched"
          : p.spec
            ? "unmatched"
            : undefined,
    }));
  return {
    quick: rows(config.tiers?.quick.providers),
    standard: rows(config.tiers?.standard.providers),
    complex: rows(config.tiers?.complex.providers),
  };
}

function clonePresets(config: LlmConfig): PresetState {
  return {
    default: config.presets?.default ?? DEFAULT_PRESETS.default,
    fast: config.presets?.fast ?? DEFAULT_PRESETS.fast,
    balanced: config.presets?.balanced ?? DEFAULT_PRESETS.balanced,
    thorough: config.presets?.thorough ?? DEFAULT_PRESETS.thorough,
  };
}

const perMtok = (n?: number): string => (n != null ? `$${(n * 1_000_000).toFixed(2)}` : "—");

function specBadges(spec: ModelSpec): string[] {
  const out = [
    `${perMtok(spec.input_cost_per_token)} / ${perMtok(spec.output_cost_per_token)} per Mtok`,
  ];
  if (spec.max_input_tokens) out.push(`${Math.round(spec.max_input_tokens / 1000)}k ctx`);
  if (spec.supports_function_calling) out.push("tools");
  if (spec.supports_vision) out.push("vision");
  if (spec.supports_prompt_caching) out.push("cache");
  if (spec.supports_reasoning) out.push("reasoning");
  if (spec.litellm_key) out.push(`↳ ${spec.litellm_key}`);
  if (spec.deprecation_date) out.push(`deprecates ${spec.deprecation_date}`);
  return out;
}

function profileIdFor(preset: string, index: number): string {
  return index === 0 ? preset : `${preset}-fallback-${index}`;
}

function providerLabel(providers: LlmProviderInfo[], provider: string): string {
  return providers.find((p) => p.id === provider)?.label ?? provider;
}

function profileOptions(
  tiers: Tiers,
  providers: LlmProviderInfo[],
  presets: PresetState
): ProfileOption[] {
  const options: ProfileOption[] = [];
  for (const chain of CHAIN_CONFIG) {
    tiers[chain.tier].forEach((row, index) => {
      const id = profileIdFor(chain.preset, index);
      const label = `${id} · ${providerLabel(providers, row.provider)} / ${row.model || "unset"}`;
      options.push({ id, label });
    });
  }

  const known = new Set(options.map((option) => option.id));
  for (const target of Object.values(presets)) {
    if (target.trim() && !known.has(target)) {
      known.add(target);
      options.push({ id: target, label: `${target} · current config` });
    }
  }
  return options;
}

function credentialKey(row: Row): string {
  return [row.provider, row.api_key_ref ?? "", row.base_url ?? "", row.resource_name ?? ""]
    .map((part) => part.replaceAll("|", "\\|"))
    .join("|");
}

function defaultFieldKey(
  info: LlmProviderInfo | undefined,
  role: "api_key" | "base_url" | "resource_name"
) {
  return info?.fields.find((field) => field.role === role)?.key;
}

function connectionDetails(row: Row, info: LlmProviderInfo | undefined): string[] {
  const apiKeyRef = row.api_key_ref?.trim() || defaultFieldKey(info, "api_key");
  const baseUrl = row.base_url?.trim();
  const resourceName = row.resource_name?.trim();
  const details = [
    `Provider: ${info?.label ?? (row.provider || "not selected")}`,
    apiKeyRef ? `API key ref: ${apiKeyRef}` : "API key ref: provider default",
  ];
  if (baseUrl) details.push(`Base URL: ${baseUrl}`);
  else if (defaultFieldKey(info, "base_url")) details.push("Base URL: provider default");
  if (resourceName) details.push(`Resource name: ${resourceName}`);
  else if (defaultFieldKey(info, "resource_name")) details.push("Resource name: provider default");
  return details;
}

function connectionSummaries(
  tiers: Tiers,
  providers: LlmProviderInfo[]
): Record<number, ConnectionSummary> {
  const rows = CHAIN_CONFIG.flatMap((chain) => tiers[chain.tier]);
  const namesByKey = new Map<string, string>();
  const countsByProvider = new Map<string, number>();
  const sharedCounts = new Map<string, number>();

  for (const row of rows) {
    const key = credentialKey(row);
    sharedCounts.set(key, (sharedCounts.get(key) ?? 0) + 1);
    if (namesByKey.has(key)) continue;
    const seen = countsByProvider.get(row.provider) ?? 0;
    countsByProvider.set(row.provider, seen + 1);
    namesByKey.set(key, seen === 0 ? row.provider : `${row.provider}-${seen + 1}`);
  }

  const summaries: Record<number, ConnectionSummary> = {};
  for (const row of rows) {
    const key = credentialKey(row);
    const info = providers.find((provider) => provider.id === row.provider);
    summaries[row.uid] = {
      name: namesByKey.get(key) ?? row.provider,
      sharedCount: sharedCounts.get(key) ?? 1,
      details: connectionDetails(row, info),
    };
  }
  return summaries;
}

const isBlank = (value: string | undefined): boolean => value === undefined || value.trim() === "";
const trimOptional = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};

function rowValue(row: Row, role: "api_key" | "base_url" | "resource_name"): string | undefined {
  if (role === "api_key") return row.api_key_ref;
  if (role === "base_url") return row.base_url;
  return row.resource_name;
}

function isRowConfigured(
  row: Row,
  provider: LlmProviderInfo | undefined,
  secretKeys: string[]
): boolean {
  if (!provider) return true;
  return provider.fields
    .filter((field) => !field.optional)
    .every((field) => !isBlank(rowValue(row, field.role)) || secretKeys.includes(field.key));
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
  const [presets, setPresets] = useState<PresetState>(() => clonePresets(initial));
  const [localError, setLocalError] = useState<string | null>(null);
  const [modelOptions, setModelOptions] = useState<Record<string, ModelOptions>>({});
  const [optionsLoading, setOptionsLoading] = useState<Record<string, boolean>>({});

  const isEnabled = (p: LlmProviderInfo) => isProviderConfigured(p, secretKeys);
  const known = new Set(providers.map((p) => p.id));
  const firstEnabled = providers.find(isEnabled);
  const hasProviderChains = initial.tiers !== undefined;
  const options = useMemo(
    () => profileOptions(tiers, providers, presets),
    [tiers, providers, presets]
  );
  const optionIds = new Set(options.map((option) => option.id));
  const connections = useMemo(() => connectionSummaries(tiers, providers), [tiers, providers]);

  async function loadModelOptions(provider: string, force = false) {
    if (!provider || provider === "azure" || !known.has(provider)) return;
    if (!force && (modelOptions[provider] || optionsLoading[provider])) return;
    setOptionsLoading((p) => ({ ...p, [provider]: true }));
    try {
      const opts = await getModelOptions(provider);
      setModelOptions((p) => ({ ...p, [provider]: opts }));
    } catch {
      setModelOptions((p) => ({
        ...p,
        [provider]: { models: [], source: "unavailable", reason: "Couldn't load model list." },
      }));
    } finally {
      setOptionsLoading((p) => ({ ...p, [provider]: false }));
    }
  }

  function autoResolve(tier: TierName, idx: number) {
    const row = tiers[tier][idx];
    if (!row?.provider || !row.model.trim() || row.spec || row.specState === "loading") return;
    void fetchSpec(tier, idx);
  }

  function patchRow(tier: TierName, idx: number, patch: Partial<Row>) {
    setTiers((prev) => ({
      ...prev,
      [tier]: prev[tier].map((r, i) => (i === idx ? { ...r, ...patch } : r)),
    }));
  }

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

  function moveProvider(tier: TierName, idx: number, direction: -1 | 1) {
    setTiers((prev) => {
      const next = [...prev[tier]];
      const target = idx + direction;
      if (target < 0 || target >= next.length) return prev;
      const current = next[idx];
      const other = next[target];
      if (!current || !other) return prev;
      next[idx] = other;
      next[target] = current;
      return { ...prev, [tier]: next };
    });
  }

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
        {
          spec: res.spec ?? undefined,
          specCandidates: res.candidates,
          specState: res.spec ? "matched" : "unmatched",
        },
        stillTarget
      );
    } catch {
      patchRowByUid(tier, uid, { specState: "error" }, stillTarget);
    }
  }

  async function selectSpecCandidate(tier: TierName, idx: number, candidate: string) {
    const row = tiers[tier][idx];
    if (!row.provider || !row.model.trim()) return;
    const { uid, provider } = row;
    const model = row.model.trim();
    const stillTarget = (item: Row) => item.provider === provider && item.model.trim() === model;
    patchRowByUid(tier, uid, { specState: "loading" }, stillTarget);
    try {
      const res = await resolveModelSpec(provider, model, false, candidate);
      patchRowByUid(
        tier,
        uid,
        {
          spec: res.spec ?? undefined,
          specCandidates: [],
          specState: res.spec ? "matched" : "unmatched",
        },
        stillTarget
      );
    } catch {
      patchRowByUid(tier, uid, { specState: "error" }, stillTarget);
    }
  }

  function setManualContextWindow(tier: TierName, idx: number, rawValue: string) {
    const value = Number(rawValue);
    const row = tiers[tier][idx];
    patchRow(tier, idx, {
      spec:
        Number.isInteger(value) && value > 0 ? { ...row.spec, max_input_tokens: value } : undefined,
      specState: Number.isInteger(value) && value > 0 ? "manual" : "unmatched",
    });
  }

  function validate(): string | null {
    if (hasProviderChains) {
      for (const chain of CHAIN_CONFIG) {
        const rows = tiers[chain.tier];
        if (rows.length === 0) return `${chain.label} needs at least one provider.`;
        for (const row of rows) {
          if (!row.provider) return `Pick a provider for every row in ${chain.label}.`;
          const info = providers.find((p) => p.id === row.provider);
          if (!isRowConfigured(row, info, secretKeys)) {
            return `${info?.label ?? row.provider} needs a Provider Connection secret or config.`;
          }
          if (!row.model.trim()) return `Set a provider model id for every row in ${chain.label}.`;
          const contextWindow = row.spec?.max_input_tokens;
          if (
            (row.specState === "unmatched" || row.specState === "error") &&
            (typeof contextWindow !== "number" || contextWindow <= 0)
          ) {
            return `${chain.label} needs a verified context window for ${row.model}.`;
          }
          const apiKeyRef = trimOptional(row.api_key_ref);
          if (apiKeyRef !== undefined && !secretKeys.includes(apiKeyRef)) {
            return `Secret ${apiKeyRef} is not stored yet.`;
          }
        }
      }
    }

    for (const field of PRESET_FIELDS) {
      const target = presets[field.key].trim();
      if (!target) return `${field.label} needs a ModelProfile target.`;
      if (hasProviderChains && !optionIds.has(target)) {
        return `${field.label} points at a ModelProfile that is not in the provider chains.`;
      }
    }
    return null;
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const problem = validate();
    setLocalError(problem);
    if (problem) return;
    const toEntries = (rows: Row[]): ProviderEntry[] =>
      rows.map((r) => {
        const apiKeyRef = trimOptional(r.api_key_ref);
        const baseUrl = trimOptional(r.base_url);
        const resourceName = trimOptional(r.resource_name);
        return {
          provider: r.provider.trim(),
          model: r.model.trim(),
          ...(apiKeyRef ? { api_key_ref: apiKeyRef } : {}),
          ...(baseUrl ? { base_url: baseUrl } : {}),
          ...(resourceName ? { resource_name: resourceName } : {}),
          ...(r.spec ? { spec: r.spec } : {}),
        };
      });
    const config: LlmConfig = {
      ...(initial.connections ? { connections: initial.connections } : {}),
      ...(hasProviderChains
        ? {
            tiers: {
              quick: { providers: toEntries(tiers.quick) },
              standard: { providers: toEntries(tiers.standard) },
              complex: { providers: toEntries(tiers.complex) },
            },
          }
        : {}),
      presets: {
        default: presets.default.trim(),
        fast: presets.fast.trim(),
        balanced: presets.balanced.trim(),
        thorough: presets.thorough.trim(),
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

      <section className="flex flex-col gap-4 rounded-sm border border-border bg-card p-4">
        <div className="flex flex-col gap-1">
          <h2 className="text-lg font-semibold text-foreground">Effort Presets</h2>
          <p className="text-sm text-muted-foreground">
            Auto resolves to the default below. Fast, Balanced, and Thorough each point at one
            ModelProfile from the provider chains.
          </p>
          <p className="text-sm text-foreground">
            When a user just types a message: <span className="font-medium">Auto</span> →{" "}
            <span className="font-mono text-sm">{presets.default || "unset"}</span>.
          </p>
        </div>
        <div className="grid gap-3 md:grid-cols-2">
          {PRESET_FIELDS.map((field) => {
            const id = `preset-${field.key}`;
            return (
              <div key={field.key} className="flex flex-col gap-1 text-sm text-foreground">
                <label htmlFor={id}>{field.label}</label>
                {options.length > 0 && hasProviderChains ? (
                  <select
                    id={id}
                    className={inputClass}
                    value={presets[field.key]}
                    onChange={(e) =>
                      setPresets((prev) => ({ ...prev, [field.key]: e.target.value }))
                    }
                    aria-label={`${field.label} ModelProfile`}
                  >
                    {options.map((option) => (
                      <option key={`${field.key}-${option.id}`} value={option.id}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    id={id}
                    className={inputClass}
                    value={presets[field.key]}
                    onChange={(e) =>
                      setPresets((prev) => ({ ...prev, [field.key]: e.target.value }))
                    }
                    aria-label={`${field.label} ModelProfile`}
                    placeholder="ModelProfile id"
                  />
                )}
                <span className="text-xs text-muted-foreground">{field.help}</span>
              </div>
            );
          })}
        </div>
      </section>

      {hasProviderChains ? (
        <section className="flex flex-col gap-4">
          <div className="flex flex-col gap-1">
            <h2 className="text-lg font-semibold text-foreground">Provider chains</h2>
            <p className="text-sm text-muted-foreground">
              Rows are ordered. TulipFarm tries the primary row first, then each fallback in order.
              Distinct credential tuples become distinct Provider Connections.
            </p>
          </div>

          {CHAIN_CONFIG.map((chain) => (
            <fieldset
              key={chain.tier}
              className="flex flex-col gap-3 rounded-sm border border-border p-4"
            >
              <legend className="px-1 text-sm font-medium text-foreground">{chain.label}</legend>
              <p className="text-sm text-muted-foreground">{chain.description}</p>

              {tiers[chain.tier].map((row, idx) => {
                const summary = connections[row.uid];
                const profileId = profileIdFor(chain.preset, idx);
                return (
                  <div
                    key={row.uid}
                    className="flex flex-col gap-3 border-t border-border pt-3 first:border-t-0 first:pt-0"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant={idx === 0 ? "primary" : "neutral"}>
                        {idx === 0 ? "Primary" : `Fallback ${idx}`}
                      </Badge>
                      <Badge variant="neutral" className="font-mono">
                        {profileId}
                      </Badge>
                      {summary ? (
                        <Badge variant={summary.sharedCount > 1 ? "info" : "neutral"}>
                          Provider Connection {summary.name}
                          {summary.sharedCount > 1 ? ` · shared by ${summary.sharedCount}` : ""}
                        </Badge>
                      ) : null}
                    </div>

                    <div className="grid grid-cols-1 items-end gap-2 lg:grid-cols-[1fr_1fr_auto]">
                      <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                        provider
                        <select
                          className={inputClass}
                          value={row.provider}
                          onChange={(e) => {
                            patchRow(chain.tier, idx, {
                              provider: e.target.value,
                              api_key_ref: undefined,
                              base_url: undefined,
                              resource_name: undefined,
                              spec: undefined,
                              specState: undefined,
                              specCandidates: undefined,
                            });
                            void loadModelOptions(e.target.value);
                          }}
                          aria-label={`${chain.label} provider ${idx + 1} provider`}
                        >
                          {row.provider && !known.has(row.provider) ? (
                            <option value={row.provider}>{row.provider}</option>
                          ) : null}
                          {providers.map((p) => (
                            <option
                              key={p.id}
                              value={p.id}
                              disabled={!isEnabled(p) && row.provider !== p.id}
                            >
                              {p.label}
                              {isEnabled(p) ? "" : " — add Provider Connection details"}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                        provider model id
                        <input
                          className={inputClass}
                          value={row.model}
                          list={
                            row.provider && row.provider !== "azure" && known.has(row.provider)
                              ? `models-${row.provider}`
                              : undefined
                          }
                          onChange={(e) =>
                            patchRow(chain.tier, idx, {
                              model: e.target.value,
                              spec: undefined,
                              specState: undefined,
                              specCandidates: undefined,
                            })
                          }
                          onFocus={() => void loadModelOptions(row.provider)}
                          onBlur={() => autoResolve(chain.tier, idx)}
                          placeholder="pick or type a provider model id"
                          aria-label={`${chain.label} provider ${idx + 1} model`}
                        />
                      </label>
                      <div className="flex flex-wrap gap-2">
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="rounded-sm"
                          disabled={idx === 0}
                          onClick={() => moveProvider(chain.tier, idx, -1)}
                        >
                          Move up
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="rounded-sm"
                          disabled={idx === tiers[chain.tier].length - 1}
                          onClick={() => moveProvider(chain.tier, idx, 1)}
                        >
                          Move down
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="rounded-sm"
                          disabled={tiers[chain.tier].length <= 1}
                          onClick={() => removeProvider(chain.tier, idx)}
                        >
                          Remove
                        </Button>
                      </div>
                    </div>

                    <div className="grid gap-2 md:grid-cols-3">
                      <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                        api key ref
                        <input
                          className={subtleInputClass}
                          value={row.api_key_ref ?? ""}
                          onChange={(e) =>
                            patchRow(chain.tier, idx, { api_key_ref: e.target.value })
                          }
                          placeholder="default provider secret"
                          aria-label={`${chain.label} provider ${idx + 1} api key ref`}
                        />
                      </label>
                      <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                        base url
                        <input
                          className={subtleInputClass}
                          value={row.base_url ?? ""}
                          onChange={(e) => patchRow(chain.tier, idx, { base_url: e.target.value })}
                          placeholder="provider default"
                          aria-label={`${chain.label} provider ${idx + 1} base url`}
                        />
                      </label>
                      <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                        resource name
                        <input
                          className={subtleInputClass}
                          value={row.resource_name ?? ""}
                          onChange={(e) =>
                            patchRow(chain.tier, idx, { resource_name: e.target.value })
                          }
                          placeholder="provider default"
                          aria-label={`${chain.label} provider ${idx + 1} resource name`}
                        />
                      </label>
                    </div>

                    {summary ? (
                      <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
                        {summary.details.map((detail) => (
                          <span
                            key={detail}
                            className="rounded-sm border border-border bg-muted/40 px-1.5 py-0.5"
                          >
                            {detail}
                          </span>
                        ))}
                      </div>
                    ) : null}

                    <div className="flex flex-wrap items-center gap-2 text-xs">
                      {row.spec ? (
                        specBadges(row.spec).map((badge) => (
                          <span
                            key={badge}
                            className="rounded-sm border border-border bg-muted/40 px-1.5 py-0.5 text-muted-foreground"
                          >
                            {badge}
                          </span>
                        ))
                      ) : row.specState === "loading" ? (
                        <span className="text-muted-foreground">Resolving spec…</span>
                      ) : row.specState === "unmatched" ? (
                        <span className="text-destructive">
                          Select the matching LiteLLM model or enter its context window.
                        </span>
                      ) : row.specState === "error" ? (
                        <span className="text-destructive">
                          Couldn&rsquo;t reach the model catalog.
                        </span>
                      ) : (
                        <span className="text-muted-foreground">Spec auto-resolves on Save.</span>
                      )}
                      {row.spec ? (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="cursor-pointer rounded-sm"
                          disabled={row.specState === "loading"}
                          onClick={() => fetchSpec(chain.tier, idx)}
                        >
                          {row.specState === "loading" ? "Refreshing…" : "Refresh"}
                        </Button>
                      ) : null}
                    </div>
                    {row.specState === "unmatched" ||
                    row.specState === "error" ||
                    row.specState === "manual" ? (
                      <div className="flex flex-col gap-2 rounded-sm border border-border p-3">
                        {row.specCandidates && row.specCandidates.length > 0 ? (
                          <div className="flex flex-wrap gap-2">
                            {row.specCandidates.map((candidate) => (
                              <Button
                                key={candidate}
                                type="button"
                                variant="outline"
                                size="sm"
                                onClick={() => selectSpecCandidate(chain.tier, idx, candidate)}
                              >
                                {candidate}
                              </Button>
                            ))}
                          </div>
                        ) : null}
                        <label className="flex max-w-xs flex-col gap-1 text-xs text-muted-foreground">
                          max input tokens
                          <input
                            type="number"
                            min={1}
                            step={1}
                            className={subtleInputClass}
                            value={row.spec?.max_input_tokens ?? ""}
                            onChange={(event) =>
                              setManualContextWindow(chain.tier, idx, event.target.value)
                            }
                            aria-label={`${chain.label} provider ${idx + 1} max input tokens`}
                          />
                          <span>
                            Use the provider&rsquo;s documented context capacity. Pricing may remain
                            unavailable.
                          </span>
                        </label>
                      </div>
                    ) : null}
                  </div>
                );
              })}

              <div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="rounded-sm"
                  onClick={() => addProvider(chain.tier)}
                >
                  + Add provider to fallback chain
                </Button>
              </div>
            </fieldset>
          ))}
        </section>
      ) : (
        <p className="rounded-sm border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
          This Soul uses authored ModelProfiles. Edit the preset targets here; ModelProfile
          authoring stays outside this settings form.
        </p>
      )}

      {Object.entries(modelOptions).map(([prov, opts]) => (
        <datalist key={prov} id={`models-${prov}`}>
          {opts.models.map((model) => (
            <option key={model} value={model} />
          ))}
        </datalist>
      ))}

      <div className="flex justify-end">
        <Button type="submit" size="sm" className="rounded-sm" disabled={submitting}>
          {submitting ? "Saving…" : "Save"}
        </Button>
      </div>
    </form>
  );
}
