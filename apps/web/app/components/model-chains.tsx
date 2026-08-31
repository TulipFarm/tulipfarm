import { useMemo, useState } from "react";
import { FormStatus } from "~/components/form-status";
import { AdvancedPanel } from "~/components/model-chains/advanced-panel";
import {
  EFFORTS,
  type EmbeddingRow,
  isEntryReady,
  PRESET_KEYS,
  type PresetKey,
  profileIdFor,
  providerLabel,
  type Row,
  type WireTier,
} from "~/components/model-chains/chain-data";
import { NoProvidersPanel, PrimaryRow } from "~/components/model-chains/chain-row";
import { ChatModelsTable } from "~/components/model-chains/chat-models-table";
import { ModelSheet } from "~/components/model-chains/model-sheet";
import { Button } from "~/components/ui/button";
import { Panel } from "~/components/ui/panel";
import {
  type EmbeddingEntry,
  isProviderConfigured,
  type LlmConfig,
  type LlmProviderInfo,
  type ProviderEntry,
} from "~/lib/settings";

const DEFAULT_PRESETS: Record<PresetKey, string> = {
  default: "balanced",
  fast: "fast",
  balanced: "balanced",
  thorough: "thorough",
};

type Chains = Record<WireTier, Row[]>;
type Presets = Record<PresetKey, string>;
type SheetTarget = { kind: "chain"; tier: WireTier } | { kind: "embedding" };

let nextUid = 0;

function toRows(entries: ProviderEntry[] | undefined): Row[] {
  return (entries ?? []).map((entry) => ({ ...entry, uid: nextUid++ }));
}

function toEmbeddingRows(entries: EmbeddingEntry[] | undefined): EmbeddingRow[] {
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

/**
 * Serialize one edited row back to config.
 *
 * The whole entry is carried across, not the fields this form knows about: an entry may declare
 * `constraints` or `budgets` that nothing here can edit, and rebuilding it field by field silently
 * deleted them on every save.
 */
function toEntry(row: Row | EmbeddingRow): ProviderEntry {
  const entry: Record<string, unknown> = { ...row };
  delete entry.uid;
  entry.provider = row.provider.trim();
  entry.model = row.model.trim();
  for (const key of ["api_key_ref", "base_url", "resource_name"]) {
    const value = entry[key];
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed) entry[key] = trimmed;
    else delete entry[key];
  }
  for (const key of ["spec", "dimension"]) {
    if (entry[key] === undefined) delete entry[key];
  }
  return entry as ProviderEntry;
}

/** The named slots a save can change, in the order a person reads them off the page. */
const SLOT_KEYS = [
  "Fast",
  "Balanced",
  "Thorough",
  "Embedding",
  "Default effort",
  "Routing",
] as const;

type Slot = (typeof SLOT_KEYS)[number];

/**
 * Split a config into independently comparable slots.
 *
 * A save bar that only says "unsaved changes" makes you re-audit the whole page to find out what
 * you touched. Diffing per slot lets it name them instead.
 */
function slots(config: LlmConfig): Record<Slot, string> {
  const presets = config.presets;
  return {
    Fast: JSON.stringify(config.tiers?.quick ?? null),
    Balanced: JSON.stringify(config.tiers?.standard ?? null),
    Thorough: JSON.stringify(config.tiers?.complex ?? null),
    Embedding: JSON.stringify(config.embeddings ?? null),
    "Default effort": JSON.stringify(presets?.default ?? null),
    Routing: JSON.stringify([presets?.fast, presets?.balanced, presets?.thorough]),
  };
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
  const [embeddings, setEmbeddings] = useState<EmbeddingRow[]>(() =>
    toEmbeddingRows(initial.embeddings?.providers)
  );
  const [presets, setPresets] = useState<Presets>(() => clonePresets(initial));
  // Both adding and editing buffer the row here until the sheet is completed. Letting a sheet write
  // into the chain as it is typed is what left a dismissed sheet with a "no model set" entry
  // behind, ready to be saved.
  const [sheet, setSheet] = useState<{
    target: SheetTarget;
    row: EmbeddingRow;
    mode: "add" | "edit";
    focus?: "pricing";
  } | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);

  const configured = useMemo(
    () => providers.filter((p) => isProviderConfigured(p, secretKeys)),
    [providers, secretKeys]
  );
  const hasChains = initial.tiers !== undefined;
  const profiles = useMemo(() => {
    const ids: { id: string; label: string }[] = [];
    for (const effort of EFFORTS) {
      chains[effort.wire].forEach((row, index) => {
        if (!row.model.trim()) return;
        const id = profileIdFor(effort.preset, index);
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

  // Which effort Auto currently lands on. Undefined when the default has been pointed at a
  // standby or a profile this page did not name, which only Advanced can express.
  const defaultEffort = EFFORTS.find((e) => presets[e.preset] === presets.default)?.preset;

  function openSheet(
    target: SheetTarget,
    row: EmbeddingRow,
    mode: "add" | "edit",
    focus?: "pricing"
  ) {
    setLocalError(null);
    setSheet({ target, row, mode, focus });
  }

  function blankRow(): EmbeddingRow {
    return { uid: nextUid++, provider: configured[0]?.id ?? providers[0]?.id ?? "", model: "" };
  }

  function mutateChain(tier: WireTier, fn: (rows: Row[]) => Row[]) {
    setChains((prev) => ({ ...prev, [tier]: fn(prev[tier]) }));
    setLocalError(null);
  }

  function mutateEmbeddings(fn: (rows: EmbeddingRow[]) => EmbeddingRow[]) {
    setEmbeddings((prev) => fn(prev));
    setLocalError(null);
  }

  function commitSheet() {
    if (!sheet) return;
    const { target, row, mode } = sheet;
    // `EmbeddingRow` only widens `Row` by an optional field, so one buffered row serves both lists.
    const write = (rows: EmbeddingRow[]): EmbeddingRow[] =>
      mode === "add" ? [...rows, row] : rows.map((r) => (r.uid === row.uid ? row : r));
    if (target.kind === "chain") mutateChain(target.tier, write);
    else mutateEmbeddings(write);
    setSheet(null);
  }

  function move<T>(rows: T[], index: number, delta: number): T[] {
    const target = index + delta;
    if (target < 0 || target >= rows.length) return rows;
    const next = [...rows];
    [next[index], next[target]] = [next[target], next[index]];
    return next;
  }

  function validate(): string | null {
    if (hasChains) {
      for (const effort of EFFORTS) {
        const rows = chains[effort.wire];
        if (rows.length === 0) return `${effort.label} needs at least one model.`;
        for (const row of rows) {
          const problem = entryProblem(row, effort.label);
          if (problem) return problem;
        }
      }
    }
    for (const row of embeddings) {
      const problem = entryProblem(row, "The embedding model");
      if (problem) return problem;
    }
    const known = new Set(profiles.map((p) => p.id));
    for (const key of PRESET_KEYS) {
      const target = presets[key].trim();
      if (!target) return `The ${key} preset needs a target.`;
      if (hasChains && !known.has(target)) {
        return `The ${key} preset points at "${target}", which is not in any chain.`;
      }
    }
    return null;
  }

  function entryProblem(row: Row | EmbeddingRow, subject: string): string | null {
    if (!row.provider.trim()) return `${subject} has an entry with no provider.`;
    if (!row.model.trim()) {
      return `${subject} has a ${providerLabel(providers, row.provider)} entry with no model.`;
    }
    // A chain entry whose provider is missing a credential cannot answer, so saving it would
    // write a config that is already known to fail at the first turn that reaches it.
    if (!isEntryReady(providers, secretKeys, row.provider)) {
      return `${subject} uses ${providerLabel(providers, row.provider)}, which has no stored credential yet.`;
    }
    return null;
  }

  function buildConfig(
    nextChains: Chains,
    nextEmbeddings: EmbeddingRow[],
    nextPresets: Presets
  ): LlmConfig {
    return {
      ...(initial.connections ? { connections: initial.connections } : {}),
      ...(hasChains
        ? {
            tiers: {
              quick: { providers: nextChains.quick.map(toEntry) },
              standard: { providers: nextChains.standard.map(toEntry) },
              complex: { providers: nextChains.complex.map(toEntry) },
            },
          }
        : {}),
      presets: {
        default: nextPresets.default.trim(),
        fast: nextPresets.fast.trim(),
        balanced: nextPresets.balanced.trim(),
        thorough: nextPresets.thorough.trim(),
      },
      ...(nextEmbeddings.length > 0
        ? { embeddings: { providers: nextEmbeddings.map(toEntry) as EmbeddingEntry[] } }
        : {}),
    };
  }

  function save() {
    const problem = validate();
    setLocalError(problem);
    if (problem) return;
    void onSubmit(buildConfig(chains, embeddings, presets));
  }

  function discard() {
    setChains(cloneChains(initial));
    setEmbeddings(toEmbeddingRows(initial.embeddings?.providers));
    setPresets(clonePresets(initial));
    setLocalError(null);
  }

  const embeddingPrimary = embeddings[0];
  const error = formError ?? localError;
  // Nothing meaningful should sit behind a closed disclosure. If this workspace has already
  // configured a standby or a non-default routing target, that state is not "advanced" to them.
  const hasAdvanced =
    EFFORTS.some((effort) => chains[effort.wire].length > 1) ||
    embeddings.length > 1 ||
    EFFORTS.some((effort) => presets[effort.preset] !== profileIdFor(effort.preset, 0));
  // Both sides go through the serializer the save uses. Diffing edits against raw `initial`
  // instead would report a page as dirty purely because it was normalized on the way in, which is
  // how a save bar ends up permanently lit and therefore permanently ignored.
  //
  // Recomputed every render rather than captured at mount, because a successful save revalidates
  // the loader without remounting this component: a frozen baseline would leave the bar still
  // offering to save work that is already saved.
  const baseline = slots(
    buildConfig(
      cloneChains(initial),
      toEmbeddingRows(initial.embeddings?.providers),
      clonePresets(initial)
    )
  );
  const current = slots(buildConfig(chains, embeddings, presets));
  const changed = SLOT_KEYS.filter((key) => current[key] !== baseline[key]);
  const dirty = changed.length > 0;

  return (
    <div className="space-y-6">
      {configured.length === 0 ? <NoProvidersPanel /> : null}

      <Panel
        title="Chat models"
        description="What answers a turn. A person picks how much effort a task deserves; these decide what that costs and how long it takes."
        flush
        footer={
          <p className="text-xs text-muted-foreground">
            {defaultEffort
              ? "The default runs whenever nobody picks an effort, so it sets what most turns cost."
              : `The default points at "${presets.default}", which is not one of these three. Change it under Advanced.`}
          </p>
        }
      >
        {hasChains ? (
          <ChatModelsTable
            chains={chains}
            providers={providers}
            secretKeys={secretKeys}
            defaultEffort={defaultEffort}
            onDefaultChange={(effort) => {
              setPresets((prev) => ({ ...prev, default: prev[effort] }));
              setLocalError(null);
            }}
            onChange={(tier, focus) =>
              openSheet(
                { kind: "chain", tier },
                chains[tier][0] ?? blankRow(),
                chains[tier][0] ? "edit" : "add",
                focus
              )
            }
          />
        ) : (
          <p className="px-4 py-6 text-sm text-muted-foreground">
            This workspace maps effort presets straight to profiles without declaring chains here,
            so there is nothing to choose on this page. Ask in chat to set them up.
          </p>
        )}
      </Panel>

      <Panel
        title="Embedding model"
        description="Turns Knowledge into vectors so search can match meaning, not just wording."
        flush
      >
        {/* Not a neutral empty state: with no embedding model, Knowledge search is degraded right
            now, and nothing else on the instance says so. */}
        {embeddingPrimary ? null : (
          <div className="mx-4 mt-4 rounded-md border border-status-warning/40 bg-status-warning/10 px-3 py-2">
            <p className="text-sm text-foreground">
              Knowledge search is running on keyword matching.
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Until an embedding model is set, retrieval cannot match meaning — only wording an
              agent happens to repeat exactly.
            </p>
          </div>
        )}
        <ul>
          <PrimaryRow
            name="Embedding"
            description="Used by Knowledge indexing and every retrieval query."
            row={embeddingPrimary}
            providers={providers}
            secretKeys={secretKeys}
            emptySpec="Pricing not looked up yet."
            meta={
              embeddingPrimary ? (
                <>
                  {embeddingPrimary.dimension ? (
                    <p className="mt-2 text-xs text-muted-foreground">
                      <span>Vector width </span>
                      <span className="tabular-nums text-foreground">
                        {embeddingPrimary.dimension}
                      </span>
                    </p>
                  ) : null}
                  <p className="mt-2 max-w-prose text-xs text-status-warning">
                    Changing this model or its width leaves existing vectors unmatchable. Re-index
                    Knowledge after saving.
                  </p>
                </>
              ) : null
            }
            onChange={() =>
              openSheet(
                { kind: "embedding" },
                embeddingPrimary ?? blankRow(),
                embeddingPrimary ? "edit" : "add"
              )
            }
          />
        </ul>
      </Panel>

      {/* A full panel whose only content is "no" claims a third of the page to say nothing. */}
      <p className="px-1 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">Image generation</span> is not supported yet.
        Agents read images where the chat model accepts them, but cannot generate any.
      </p>

      <AdvancedPanel
        defaultOpen={hasAdvanced}
        hasChains={hasChains}
        chains={chains}
        embeddings={embeddings}
        presets={presets}
        profiles={profiles}
        providers={providers}
        secretKeys={secretKeys}
        onAddChainRow={(tier) => openSheet({ kind: "chain", tier }, blankRow(), "add")}
        onEditChainRow={(tier, row) => openSheet({ kind: "chain", tier }, row, "edit")}
        onMoveChainRow={(tier, index, delta) =>
          mutateChain(tier, (rows) => move(rows, index, delta))
        }
        onRemoveChainRow={(tier, row) =>
          mutateChain(tier, (rows) => rows.filter((r) => r.uid !== row.uid))
        }
        onAddEmbedding={() => openSheet({ kind: "embedding" }, blankRow(), "add")}
        onEditEmbedding={(row) => openSheet({ kind: "embedding" }, row, "edit")}
        onMoveEmbedding={(index, delta) => mutateEmbeddings((rows) => move(rows, index, delta))}
        onRemoveEmbedding={(row) =>
          mutateEmbeddings((rows) => rows.filter((r) => r.uid !== row.uid))
        }
        onPresetChange={(key, value) => {
          setPresets((prev) => ({ ...prev, [key]: value }));
          setLocalError(null);
        }}
      />

      {error ? <FormStatus tone="error">{error}</FormStatus> : null}

      {/*
        Sticky inside the page column, not fixed to the viewport: a viewport-fixed bar spans under
        the sidebar and covers its Settings and account controls. The negative margins cancel the
        column's own gutters so the bar meets the edges the panels above it already sit on.
      */}
      <div
        className={`sticky bottom-0 z-20 -mx-4 -mb-6 border-t px-4 py-3 backdrop-blur sm:-mx-6 sm:px-6 md:-mx-8 md:px-8 ${
          dirty ? "border-primary/50 bg-primary/5" : "border-border bg-card/95"
        }`}
      >
        <div className="flex flex-wrap items-center justify-between gap-3 pr-14">
          {dirty ? (
            <p className="text-xs text-foreground">
              <span className="font-medium">Not saved yet: </span>
              <span>{changed.join(", ")}</span>
              <span className="block text-muted-foreground">
                Editing a model here changes nothing until you save.
              </span>
            </p>
          ) : (
            <p className="text-xs text-muted-foreground">
              Everything on this page is saved. Saving replaces the whole config and reloads the LLM
              service.
            </p>
          )}
          <div className="flex items-center gap-2">
            {dirty ? (
              <Button variant="ghost" size="sm" onClick={discard} disabled={submitting}>
                Discard
              </Button>
            ) : null}
            {/* Only the dirty state gets the primary treatment. A bar that looks identical whether
                or not there is anything to save is a bar you stop reading. */}
            <Button
              size="sm"
              variant={dirty ? "default" : "outline"}
              onClick={save}
              disabled={submitting || !dirty}
            >
              {submitting ? "Saving…" : dirty ? "Save changes" : "Saved"}
            </Button>
          </div>
        </div>
      </div>

      <ModelSheet
        open={sheet !== null}
        kind={sheet?.target.kind === "embedding" ? "embedding" : "chat"}
        title={sheet?.target.kind === "embedding" ? "Embedding model" : "Chat model"}
        row={sheet?.row}
        focusPricing={sheet?.focus === "pricing"}
        providers={providers}
        secretKeys={secretKeys}
        onCancel={() => setSheet(null)}
        onDone={commitSheet}
        onChange={(patch) =>
          setSheet((prev) => (prev ? { ...prev, row: { ...prev.row, ...patch } } : prev))
        }
      />
    </div>
  );
}
