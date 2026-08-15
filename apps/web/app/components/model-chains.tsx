import { Plus } from "lucide-react";
import { useMemo, useState } from "react";
import { FormStatus } from "~/components/form-status";
import { providerLabel, type Row } from "~/components/model-chains/chain-data";
import { ChainRow, NoProvidersPanel } from "~/components/model-chains/chain-row";
import { ModelSheet } from "~/components/model-chains/model-sheet";
import { Button } from "~/components/ui/button";
import { Field } from "~/components/ui/field";
import { Input } from "~/components/ui/input";
import { Panel, PanelEmpty } from "~/components/ui/panel";
import { Select } from "~/components/ui/select";
import {
  isProviderConfigured,
  type LlmConfig,
  type LlmProviderInfo,
  type ProviderEntry,
} from "~/lib/settings";

/* Retired wire tiers map to effort presets only here. */
const TIERS = [
  {
    wire: "quick",
    preset: "fast",
    label: "Fast",
    description: "Short turns where latency matters more than depth.",
  },
  {
    wire: "standard",
    preset: "balanced",
    label: "Balanced",
    description: "The everyday chain. Most turns run here.",
  },
  {
    wire: "complex",
    preset: "thorough",
    label: "Thorough",
    description: "Harder work that is worth a slower, stronger model.",
  },
] as const;

type WireTier = (typeof TIERS)[number]["wire"];
type PresetKey = "default" | "fast" | "balanced" | "thorough";

const DEFAULT_PRESETS: Record<PresetKey, string> = {
  default: "balanced",
  fast: "fast",
  balanced: "balanced",
  thorough: "thorough",
};

type Chains = Record<WireTier, Row[]>;
type Presets = Record<PresetKey, string>;

let nextUid = 0;

function toRows(entries: ProviderEntry[] | undefined): Row[] {
  return (entries ?? []).map((entry) => ({ ...entry, uid: nextUid++ }));
}

function cloneChains(config: LlmConfig): Chains {
  return {
    quick: toRows(config.tiers?.quick.providers),
    standard: toRows(config.tiers?.standard.providers),
    complex: toRows(config.tiers?.complex.providers),
  };
}

function clonePresets(config: LlmConfig): Presets {
  return {
    default: config.presets?.default ?? DEFAULT_PRESETS.default,
    fast: config.presets?.fast ?? DEFAULT_PRESETS.fast,
    balanced: config.presets?.balanced ?? DEFAULT_PRESETS.balanced,
    thorough: config.presets?.thorough ?? DEFAULT_PRESETS.thorough,
  };
}

function profileIdFor(preset: string, index: number): string {
  return index === 0 ? preset : `${preset}-fallback-${index}`;
}

function trimOptional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function ModelChains({
  initial,
  providers,
  secretKeys,
  onSubmit,
  submitting,
  formError,
}: {
  initial: LlmConfig;
  providers: LlmProviderInfo[];
  secretKeys: string[];
  onSubmit: (config: LlmConfig) => void | Promise<void>;
  submitting: boolean;
  formError: string | null;
}) {
  const [chains, setChains] = useState<Chains>(() => cloneChains(initial));
  const [presets, setPresets] = useState<Presets>(() => clonePresets(initial));
  const [editing, setEditing] = useState<{ tier: WireTier; uid: number } | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);

  const configured = useMemo(
    () => providers.filter((p) => isProviderConfigured(p, secretKeys)),
    [providers, secretKeys]
  );
  const hasChains = initial.tiers !== undefined;

  const profiles = useMemo(() => {
    const ids: { id: string; label: string }[] = [];
    for (const tier of TIERS) {
      chains[tier.wire].forEach((row, index) => {
        const id = profileIdFor(tier.preset, index);
        ids.push({
          id,
          label: `${id} · ${providerLabel(providers, row.provider)} / ${row.model || "unset"}`,
        });
      });
    }
    const known = new Set(ids.map((o) => o.id));
    for (const target of Object.values(presets)) {
      if (target.trim() && !known.has(target)) {
        known.add(target);
        ids.push({ id: target, label: `${target} · not declared above` });
      }
    }
    return ids;
  }, [chains, presets, providers]);

  const editingRow = editing ? chains[editing.tier].find((r) => r.uid === editing.uid) : undefined;

  function mutate(tier: WireTier, fn: (rows: Row[]) => Row[]) {
    setChains((prev) => ({ ...prev, [tier]: fn(prev[tier]) }));
    setLocalError(null);
  }

  function updateRow(tier: WireTier, uid: number, patch: Partial<Row>) {
    mutate(tier, (rows) => rows.map((r) => (r.uid === uid ? { ...r, ...patch } : r)));
  }

  function addRow(tier: WireTier) {
    const uid = nextUid++;
    mutate(tier, (rows) => [
      ...rows,
      { uid, provider: configured[0]?.id ?? providers[0]?.id ?? "", model: "" },
    ]);
    setEditing({ tier, uid });
  }

  function move(tier: WireTier, index: number, delta: number) {
    mutate(tier, (rows) => {
      const next = [...rows];
      const target = index + delta;
      if (target < 0 || target >= next.length) return rows;
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }

  function validate(): string | null {
    if (hasChains) {
      for (const tier of TIERS) {
        const rows = chains[tier.wire];
        if (rows.length === 0) return `${tier.label} needs at least one model.`;
        for (const row of rows) {
          if (!row.provider.trim()) return `${tier.label} has an entry with no provider.`;
          if (!row.model.trim()) {
            return `${tier.label} has a ${providerLabel(providers, row.provider)} entry with no model.`;
          }
          // A chain entry whose provider is missing a credential cannot answer, so saving it would
          // write a config that is already known to fail at the first turn that reaches it.
          const info = providers.find((p) => p.id === row.provider);
          if (!info || !isProviderConfigured(info, secretKeys)) {
            return `${tier.label} uses ${providerLabel(providers, row.provider)}, which has no stored credential yet.`;
          }
        }
      }
    }
    const known = new Set(profiles.map((p) => p.id));
    for (const key of ["default", "fast", "balanced", "thorough"] as PresetKey[]) {
      const target = presets[key].trim();
      if (!target) return `The ${key} preset needs a target.`;
      if (hasChains && !known.has(target)) {
        return `The ${key} preset points at "${target}", which is not in any chain.`;
      }
    }
    return null;
  }

  function save() {
    const problem = validate();
    setLocalError(problem);
    if (problem) return;

    const toEntries = (rows: Row[]): ProviderEntry[] =>
      rows.map((row) => ({
        provider: row.provider.trim(),
        model: row.model.trim(),
        ...(trimOptional(row.api_key_ref) ? { api_key_ref: row.api_key_ref?.trim() } : {}),
        ...(trimOptional(row.base_url) ? { base_url: row.base_url?.trim() } : {}),
        ...(trimOptional(row.resource_name) ? { resource_name: row.resource_name?.trim() } : {}),
        ...(row.spec ? { spec: row.spec } : {}),
      }));

    void onSubmit({
      ...(initial.connections ? { connections: initial.connections } : {}),
      ...(hasChains
        ? {
            tiers: {
              quick: { providers: toEntries(chains.quick) },
              standard: { providers: toEntries(chains.standard) },
              complex: { providers: toEntries(chains.complex) },
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
    });
  }

  return (
    <div className="space-y-6">
      {configured.length === 0 ? <NoProvidersPanel /> : null}

      {hasChains ? (
        TIERS.map((tier) => (
          <Panel
            key={tier.wire}
            title={tier.label}
            description={tier.description}
            actions={
              <Button variant="outline" size="sm" onClick={() => addRow(tier.wire)}>
                <Plus aria-hidden /> Add fallback
              </Button>
            }
            flush
          >
            {chains[tier.wire].length === 0 ? (
              <PanelEmpty>
                Nothing configured — {tier.label} turns will fail until a model is added.
              </PanelEmpty>
            ) : (
              <ol>
                {chains[tier.wire].map((row, index) => (
                  <ChainRow
                    key={row.uid}
                    row={row}
                    index={index}
                    total={chains[tier.wire].length}
                    providers={providers}
                    secretKeys={secretKeys}
                    profileId={profileIdFor(tier.preset, index)}
                    onEdit={() => setEditing({ tier: tier.wire, uid: row.uid })}
                    onMove={(delta) => move(tier.wire, index, delta)}
                    onRemove={() =>
                      mutate(tier.wire, (rows) => rows.filter((r) => r.uid !== row.uid))
                    }
                  />
                ))}
              </ol>
            )}
          </Panel>
        ))
      ) : (
        <Panel
          title="Provider chains"
          description="This workspace maps effort presets straight to profiles without declaring chains here. Edit soul.yaml to add them."
        >
          <PanelEmpty>No chains declared.</PanelEmpty>
        </Panel>
      )}

      <Panel
        title="What each effort means"
        description="Auto is a request, not an outcome — it resolves to whichever profile you pick below."
        footer={
          <>
            <span className="text-xs text-muted-foreground">
              Saving replaces the whole config and reloads the LLM service.
            </span>
            <Button size="sm" onClick={save} disabled={submitting}>
              {submitting ? "Saving…" : "Save changes"}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          {(formError ?? localError) ? (
            <FormStatus tone="error">{formError ?? localError}</FormStatus>
          ) : null}
          <div className="grid gap-4 sm:grid-cols-2">
            {(["default", "fast", "balanced", "thorough"] as PresetKey[]).map((key) => (
              <Field
                key={key}
                label={
                  key === "default" ? "Auto resolves to" : `${key[0].toUpperCase()}${key.slice(1)}`
                }
                help={
                  key === "default"
                    ? "Used when nobody picks an effort."
                    : `Used when ${key} is chosen explicitly.`
                }
              >
                {profiles.length > 0 && hasChains ? (
                  <Select
                    value={presets[key]}
                    onChange={(e) => setPresets((prev) => ({ ...prev, [key]: e.target.value }))}
                  >
                    {profiles.map((profile) => (
                      <option key={profile.id} value={profile.id}>
                        {profile.label}
                      </option>
                    ))}
                  </Select>
                ) : (
                  <Input
                    value={presets[key]}
                    onChange={(e) => setPresets((prev) => ({ ...prev, [key]: e.target.value }))}
                  />
                )}
              </Field>
            ))}
          </div>
        </div>
      </Panel>

      <ModelSheet
        open={editingRow !== undefined}
        row={editingRow}
        providers={providers}
        secretKeys={secretKeys}
        onClose={() => setEditing(null)}
        onChange={(patch) => {
          if (editing) updateRow(editing.tier, editing.uid, patch);
        }}
      />
    </div>
  );
}
