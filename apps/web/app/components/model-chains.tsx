import { llmConfigMode } from "@tulipfarm/schema/llm";
import { useMemo, useState } from "react";
import { FormStatus } from "~/components/form-status";
import { AdvancedPanel } from "~/components/model-chains/advanced-panel";
import {
  EFFORTS,
  type EffortKey,
  type EmbeddingRow,
  isEntryReady,
  providerLabel,
  type Row,
  type WireTier,
} from "~/components/model-chains/chain-data";
import { NoProvidersPanel, PrimaryRow } from "~/components/model-chains/chain-row";
import { ModelSheet } from "~/components/model-chains/model-sheet";
import { Button } from "~/components/ui/button";
import { ConfirmModal } from "~/components/ui/modal";
import { Panel } from "~/components/ui/panel";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "~/components/ui/tabs";
import {
  type EmbeddingEntry,
  isProviderConfigured,
  type LlmConfig,
  type LlmProviderInfo,
  type ProviderEntry,
} from "~/lib/settings";

/**
 * Each effort routes to its own first-choice model — the routing itself is never user-editable,
 * so this is written on every save rather than carried as form state. `default` is the one preset
 * choice a person makes; it is tracked separately (see `defaultEffort`) rather than fixed here.
 */
const PRESET_ROUTES = {
  fast: "fast",
  balanced: "balanced",
  thorough: "thorough",
} as const;

function initialDefaultEffort(config: LlmConfig): EffortKey {
  const preset = config.presets?.default;
  return EFFORTS.some((effort) => effort.preset === preset) ? (preset as EffortKey) : "balanced";
}

type Chains = Record<WireTier, Row[]>;
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
const SLOT_KEYS = ["Fast", "Balanced", "Thorough", "Embedding", "Default"] as const;

type Slot = (typeof SLOT_KEYS)[number];

/**
 * Split a config into independently comparable slots.
 *
 * A save bar that only says "unsaved changes" makes you re-audit the whole page to find out what
 * you touched. Diffing per slot lets it name them instead.
 */
function slots(config: LlmConfig): Record<Slot, string> {
  return {
    Fast: JSON.stringify(config.tiers?.quick ?? null),
    Balanced: JSON.stringify(config.tiers?.standard ?? null),
    Thorough: JSON.stringify(config.tiers?.complex ?? null),
    Embedding: JSON.stringify(config.embeddings ?? null),
    Default: JSON.stringify(config.presets?.default ?? null),
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
  // The tab is a view over one shared unsaved draft, not a route: switching writes nothing, and
  // `mode` only flips to match on the save that follows. Opens on whichever tab the config was
  // last saved from (or infers one for a config with no `mode` — see `llmConfigMode`).
  const [tab, setTab] = useState<"basic" | "advanced">(() => llmConfigMode(initial));
  // Which effort Auto resolves to. Basic always writes "balanced" regardless of this state; only
  // Advanced lets the operator choose, mirroring the radio the pre-tabs table used to carry.
  const [defaultEffort, setDefaultEffort] = useState<EffortKey>(() =>
    initialDefaultEffort(initial)
  );
  // Saving Basic over a config that still has per-effort differences or standbys would silently
  // drop them, so that save is held here until the operator confirms.
  const [pendingBasicSave, setPendingBasicSave] = useState<{
    chains: Chains;
    embeddings: EmbeddingRow[];
  } | null>(null);
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
  // Removing a standby chain entry or embedding is destructive with no undo, so it is held here
  // until the operator confirms — mirrors `pendingBasicSave`'s gate on the Basic flatten-save.
  const [pendingRemove, setPendingRemove] = useState<
    { kind: "chain"; tier: WireTier; row: Row } | { kind: "embedding"; row: EmbeddingRow } | null
  >(null);

  const configured = useMemo(
    () => providers.filter((p) => isProviderConfigured(p, secretKeys)),
    [providers, secretKeys]
  );
  const hasChains = initial.tiers !== undefined;

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

  function validate(rows: Chains, embeddingRows: EmbeddingRow[]): string | null {
    if (hasChains) {
      for (const effort of EFFORTS) {
        const effortRows = rows[effort.wire];
        if (effortRows.length === 0) return `${effort.label} needs at least one model.`;
        for (const row of effortRows) {
          const problem = entryProblem(row, effort.label);
          if (problem) return problem;
        }
      }
    }
    for (const row of embeddingRows) {
      const problem = entryProblem(row, "The embedding model");
      if (problem) return problem;
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
    nextMode: "basic" | "advanced",
    nextDefault: EffortKey
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
      presets: { default: nextDefault, ...PRESET_ROUTES },
      ...(nextEmbeddings.length > 0
        ? { embeddings: { providers: nextEmbeddings.map(toEntry) as EmbeddingEntry[] } }
        : {}),
      mode: nextMode,
    };
  }

  /** Basic writes one model onto every tier and clears standbys — the chain state a save from
   *  Advanced left behind is not carried through, even if the operator never reopened it. */
  function flattenToBasic(rows: Chains): Chains {
    const primary = rows.quick[0] ?? rows.standard[0] ?? rows.complex[0];
    if (!primary) return { quick: [], standard: [], complex: [] };
    return {
      quick: [primary],
      standard: [{ ...primary, uid: nextUid++ }],
      complex: [{ ...primary, uid: nextUid++ }],
    };
  }

  function save() {
    if (tab === "basic") {
      const flatChains = flattenToBasic(chains);
      const flatEmbeddings = embeddings.length > 1 ? [embeddings[0]] : embeddings;
      const problem = validate(flatChains, flatEmbeddings);
      setLocalError(problem);
      if (problem) return;
      if (hasAdvanced) {
        setPendingBasicSave({ chains: flatChains, embeddings: flatEmbeddings });
        return;
      }
      void onSubmit(buildConfig(flatChains, flatEmbeddings, "basic", "balanced"));
      return;
    }
    const problem = validate(chains, embeddings);
    setLocalError(problem);
    if (problem) return;
    void onSubmit(buildConfig(chains, embeddings, "advanced", defaultEffort));
  }

  function confirmBasicSave() {
    if (!pendingBasicSave) return;
    const { chains: flatChains, embeddings: flatEmbeddings } = pendingBasicSave;
    setPendingBasicSave(null);
    void onSubmit(buildConfig(flatChains, flatEmbeddings, "basic", "balanced"));
  }

  function confirmRemove() {
    if (!pendingRemove) return;
    if (pendingRemove.kind === "chain") {
      const { tier, row } = pendingRemove;
      mutateChain(tier, (rows) => rows.filter((r) => r.uid !== row.uid));
    } else {
      const { row } = pendingRemove;
      mutateEmbeddings((rows) => rows.filter((r) => r.uid !== row.uid));
    }
    setPendingRemove(null);
  }

  function discard() {
    setChains(cloneChains(initial));
    setEmbeddings(toEmbeddingRows(initial.embeddings?.providers));
    setTab(llmConfigMode(initial));
    setDefaultEffort(initialDefaultEffort(initial));
    setLocalError(null);
  }

  const embeddingPrimary = embeddings[0];
  const error = formError ?? localError;
  // Nothing meaningful should sit behind a closed disclosure. If this workspace has already
  // configured a standby or a per-effort model difference, that state is not "advanced" to them.
  // Mirrors `llmConfigMode`'s `tiersDiffer` check — without it, a config with one model per tier
  // and no standbys (the most common advanced shape) read as "not advanced" and let a Basic save
  // flatten it with no confirmation.
  const [firstTier, ...restTiers] = EFFORTS.map((effort) => chains[effort.wire][0]);
  const tiersDiffer = restTiers.some(
    (entry) => entry?.provider !== firstTier?.provider || entry?.model !== firstTier?.model
  );
  const hasAdvanced =
    tiersDiffer ||
    EFFORTS.some((effort) => chains[effort.wire].length > 1) ||
    embeddings.length > 1;
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
      llmConfigMode(initial),
      initialDefaultEffort(initial)
    )
  );
  const current = slots(
    buildConfig(chains, embeddings, tab, tab === "basic" ? "balanced" : defaultEffort)
  );
  const changed = SLOT_KEYS.filter((key) => current[key] !== baseline[key]);
  const dirty = changed.length > 0;

  return (
    <div className="space-y-6">
      {configured.length === 0 ? <NoProvidersPanel /> : null}

      <Tabs value={tab} onValueChange={(value) => setTab(value as "basic" | "advanced")}>
        <TabsList>
          <TabsTrigger value="basic">Basic</TabsTrigger>
          <TabsTrigger value="advanced">Advanced</TabsTrigger>
        </TabsList>

        <TabsContent value="basic" className="space-y-4">
          <Panel
            title="Chat model"
            description="One model for every effort. Switch to Advanced to give each its own model."
            flush
          >
            {hasChains ? (
              <ul>
                <PrimaryRow
                  name="Chat model"
                  description="Answers every turn."
                  row={chains.quick[0]}
                  providers={providers}
                  secretKeys={secretKeys}
                  emptySpec="Pricing not looked up yet."
                  compact
                  onChange={() =>
                    openSheet(
                      { kind: "chain", tier: "quick" },
                      chains.quick[0] ?? blankRow(),
                      chains.quick[0] ? "edit" : "add"
                    )
                  }
                />
              </ul>
            ) : (
              <p className="px-4 py-6 text-sm text-muted-foreground">
                This workspace maps effort presets straight to profiles without declaring chains
                here, so there is nothing to choose on this page. Ask in chat to set them up.
              </p>
            )}
          </Panel>

          <Panel
            title="Embedding model"
            description="Powers Knowledge search. Switch to Advanced to add standbys."
            flush
          >
            <ul>
              <PrimaryRow
                name="Embedding model"
                description="Used by Knowledge indexing and every retrieval query."
                row={embeddingPrimary}
                providers={providers}
                secretKeys={secretKeys}
                emptySpec="Pricing not looked up yet."
                compact
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
        </TabsContent>

        <TabsContent value="advanced" className="space-y-4">
          <AdvancedPanel
            hasChains={hasChains}
            chains={chains}
            embeddings={embeddings}
            providers={providers}
            secretKeys={secretKeys}
            defaultEffort={defaultEffort}
            onSetDefaultEffort={setDefaultEffort}
            onOpenPrimary={(tier) =>
              openSheet(
                { kind: "chain", tier },
                chains[tier][0] ?? blankRow(),
                chains[tier][0] ? "edit" : "add"
              )
            }
            onAddChainRow={(tier) => openSheet({ kind: "chain", tier }, blankRow(), "add")}
            onEditChainRow={(tier, row) => openSheet({ kind: "chain", tier }, row, "edit")}
            onMoveChainRow={(tier, index, delta) =>
              mutateChain(tier, (rows) => move(rows, index, delta))
            }
            onRemoveChainRow={(tier, row) => setPendingRemove({ kind: "chain", tier, row })}
            onOpenPrimaryEmbedding={() =>
              openSheet(
                { kind: "embedding" },
                embeddingPrimary ?? blankRow(),
                embeddingPrimary ? "edit" : "add"
              )
            }
            onAddEmbedding={() => openSheet({ kind: "embedding" }, blankRow(), "add")}
            onEditEmbedding={(row) => openSheet({ kind: "embedding" }, row, "edit")}
            onMoveEmbedding={(index, delta) => mutateEmbeddings((rows) => move(rows, index, delta))}
            onRemoveEmbedding={(row) => setPendingRemove({ kind: "embedding", row })}
          />
        </TabsContent>
      </Tabs>

      {/* A full panel whose only content is "no" claims a third of the page to say nothing. */}
      <p className="px-1 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">Image generation</span> is not supported yet.
        Agents read images where the chat model accepts them, but cannot generate any.
      </p>

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

      <ConfirmModal
        open={pendingBasicSave !== null}
        onClose={() => setPendingBasicSave(null)}
        onConfirm={confirmBasicSave}
        title="Switch to one model?"
        description="Basic runs a single model for every effort. Saving will drop the per-effort models and standby chains this workspace has configured today."
        confirmLabel="Switch to Basic"
      />

      <ConfirmModal
        open={pendingRemove !== null}
        onClose={() => setPendingRemove(null)}
        onConfirm={confirmRemove}
        title="Remove this standby?"
        description={`Remove "${pendingRemove?.row.model || "this entry"}"? Turns fall through to the next standby in the chain immediately. This cannot be undone.`}
        confirmLabel="Remove standby"
      />
    </div>
  );
}
