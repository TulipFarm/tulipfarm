import { Link } from "@remix-run/react";
import { ArrowDown, ArrowUp, KeyRound, Plus, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { FormStatus } from "~/components/form-status";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Field } from "~/components/ui/field";
import { Input } from "~/components/ui/input";
import { Panel, PanelEmpty } from "~/components/ui/panel";
import { Select } from "~/components/ui/select";
import { Sheet } from "~/components/ui/sheet";
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
import { cn } from "~/lib/utils";

/*
 * The wire still carries the retired tier names `quick`/`standard`/`complex`. They are aliases and
 * never shown — `metadata/terminologies.md` retires them in favour of the effort presets a person
 * actually chooses in Chat. This table is the only place the two vocabularies meet.
 */
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

type Row = ProviderEntry & { uid: number };
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

function providerLabel(providers: LlmProviderInfo[], id: string): string {
  return providers.find((p) => p.id === id)?.label ?? id;
}

const perMtok = (n?: number): string => (n != null ? `$${(n * 1_000_000).toFixed(2)}` : "—");

function specFacts(spec: ModelSpec | undefined): string[] {
  if (!spec) return [];
  const facts: string[] = [];
  if (spec.input_cost_per_token != null || spec.output_cost_per_token != null) {
    facts.push(
      `${perMtok(spec.input_cost_per_token)}/${perMtok(spec.output_cost_per_token)} per Mtok`
    );
  }
  if (spec.max_input_tokens) facts.push(`${Math.round(spec.max_input_tokens / 1000)}k context`);
  if (spec.supports_function_calling) facts.push("tools");
  if (spec.supports_vision) facts.push("vision");
  return facts;
}

function trimOptional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Models, organised by the effort a person asks for rather than by the provider that answers.
 *
 * The unit on screen is the effort preset, because that is the only part of this a Chat participant
 * ever selects. Each preset owns an ordered fallback chain: the first entry that answers, wins.
 */
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

function NoProvidersPanel() {
  return (
    <Panel className="border-status-warning/40">
      <div className="flex items-start gap-3">
        <KeyRound className="mt-0.5 size-5 shrink-0 text-status-warning" aria-hidden="true" />
        <div className="min-w-0 space-y-2">
          <p className="text-sm font-medium text-foreground">No provider is configured yet</p>
          <p className="text-sm text-muted-foreground">
            Every chain below will fail until at least one provider has its credentials stored.
            Nothing here needs to change first — add the credential, then come back.
          </p>
          <Button asChild variant="outline" size="sm">
            <Link to="/business/secrets">Add provider credentials</Link>
          </Button>
        </div>
      </div>
    </Panel>
  );
}

function ChainRow({
  row,
  index,
  total,
  providers,
  secretKeys,
  profileId,
  onEdit,
  onMove,
  onRemove,
}: {
  row: Row;
  index: number;
  total: number;
  providers: LlmProviderInfo[];
  secretKeys: string[];
  profileId: string;
  onEdit: () => void;
  onMove: (delta: number) => void;
  onRemove: () => void;
}) {
  const info = providers.find((p) => p.id === row.provider);
  const ready = info ? isProviderConfigured(info, secretKeys) : false;
  const facts = specFacts(row.spec);

  return (
    <li className="flex items-center gap-3 border-b border-border px-4 py-3 last:border-b-0">
      <span
        className="w-6 shrink-0 text-center text-sm tabular-nums text-muted-foreground"
        aria-hidden="true"
      >
        {index + 1}
      </span>

      <button
        type="button"
        onClick={onEdit}
        aria-label={`Edit ${row.model || "empty entry"}`}
        className="min-w-0 flex-1 rounded-sm text-left focus-visible:-outline-offset-2"
      >
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-sm font-medium text-foreground">
            {providerLabel(providers, row.provider) || "No provider"}
          </span>
          <span className="font-mono text-xs text-muted-foreground">
            {row.model || "no model set"}
          </span>
          {index === 0 ? <Badge variant="primary">Primary</Badge> : null}
          {ready ? null : <Badge variant="warning">No credential</Badge>}
        </span>
        <span className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
          <span className="font-mono">{profileId}</span>
          {facts.length > 0 ? <span>· {facts.join(" · ")}</span> : null}
        </span>
      </button>

      <div className="flex shrink-0 items-center gap-0.5">
        <Button
          variant="ghost"
          size="icon"
          className="size-8"
          disabled={index === 0}
          onClick={() => onMove(-1)}
          aria-label={`Move ${row.model || "entry"} earlier`}
        >
          <ArrowUp aria-hidden />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-8"
          disabled={index === total - 1}
          onClick={() => onMove(1)}
          aria-label={`Move ${row.model || "entry"} later`}
        >
          <ArrowDown aria-hidden />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-8 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
          onClick={onRemove}
          aria-label={`Remove ${row.model || "entry"}`}
        >
          <Trash2 aria-hidden />
        </Button>
      </div>
    </li>
  );
}

/**
 * Provider and model picking, moved off the page.
 *
 * Inline editors made the chain unreadable — a list whose whole point is order was buried under
 * four inputs per row. The drawer keeps the ordering visible behind it.
 */
function ModelSheet({
  open,
  row,
  providers,
  secretKeys,
  onClose,
  onChange,
}: {
  open: boolean;
  row: Row | undefined;
  providers: LlmProviderInfo[];
  secretKeys: string[];
  onClose: () => void;
  onChange: (patch: Partial<Row>) => void;
}) {
  const [options, setOptions] = useState<ModelOptions | null>(null);
  const [resolving, setResolving] = useState(false);
  const [candidates, setCandidates] = useState<string[]>([]);
  const [unmatched, setUnmatched] = useState(false);
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

  /**
   * Pin pricing and context limits for the entered model.
   *
   * A catalogue lookup has three outcomes, and all three need a resolution: an exact match pins the
   * spec; several near-matches need the operator to say which one this is; no match at all still
   * needs a context window, or the runtime has no budget to plan against.
   */
  async function pinSpec(candidate?: string) {
    if (!provider || !model) return;
    setResolving(true);
    try {
      const result = await resolveModelSpec(provider, model, false, candidate);
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

  return (
    <Sheet open={open} onClose={onClose} title="Model">
      {row ? (
        <div className="space-y-4 p-4">
          <Field label="Provider" help={ready ? undefined : "This provider has no credential yet."}>
            <Select
              value={row.provider}
              onChange={(e) => onChange({ provider: e.target.value, model: "", spec: undefined })}
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
            help={
              options?.source === "live"
                ? "Listed from your configured endpoint."
                : options?.source === "catalog"
                  ? "Suggested from the model catalog. Any ID your provider accepts will work."
                  : (options?.reason ?? "Enter the ID exactly as your provider spells it.")
            }
          >
            <Input
              list={options && options.models.length > 0 ? "model-options" : undefined}
              value={row.model}
              onChange={(e) => {
                onChange({ model: e.target.value, spec: undefined });
                setCandidates([]);
                setUnmatched(false);
              }}
              onBlur={() => {
                if (row.model.trim() && !row.spec) void pinSpec();
              }}
              placeholder="e.g. gpt-4o-mini"
              className="font-mono"
            />
          </Field>
          {options && options.models.length > 0 ? (
            <datalist id="model-options">
              {options.models.map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
          ) : null}

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
            <Button size="sm" onClick={onClose}>
              Done
            </Button>
          </div>
        </div>
      ) : null}
    </Sheet>
  );
}
