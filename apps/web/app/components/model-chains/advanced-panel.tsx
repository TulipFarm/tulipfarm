import { useId } from "react";
import { Plus } from "~/components/icons";
import {
  EFFORTS,
  type EffortKey,
  type EmbeddingRow,
  profileIdFor,
  type Row,
  type WireTier,
} from "~/components/model-chains/chain-data";
import { ChainRow, PrimaryRow } from "~/components/model-chains/chain-row";
import { Button } from "~/components/ui/button";
import type { LlmProviderInfo } from "~/lib/settings";

type Chains = Record<WireTier, Row[]>;

function EffortCard({
  effort,
  rows,
  providers,
  secretKeys,
  isDefault,
  defaultGroup,
  onSetDefault,
  onOpenPrimary,
  onAddStandby,
  onEditStandby,
  onMoveStandby,
  onRemoveStandby,
}: {
  effort: (typeof EFFORTS)[number];
  rows: Row[];
  providers: LlmProviderInfo[];
  secretKeys: string[];
  isDefault: boolean;
  defaultGroup: string;
  onSetDefault: () => void;
  onOpenPrimary: () => void;
  onAddStandby: () => void;
  onEditStandby: (row: Row) => void;
  onMoveStandby: (index: number, delta: number) => void;
  onRemoveStandby: (row: Row) => void;
}) {
  const standbys = rows.slice(1);
  return (
    <section className="overflow-hidden rounded-md border border-border">
      <div className="flex items-start gap-3 border-b border-border px-4 py-2.5">
        <input
          type="radio"
          name={defaultGroup}
          checked={isDefault}
          onChange={onSetDefault}
          aria-label={`Make ${effort.label} the default effort`}
          className="mt-0.5 size-4 accent-primary"
        />
        <div>
          <h4 className="text-sm font-medium text-foreground">{effort.label}</h4>
          <p className="mt-0.5 text-xs text-muted-foreground">{effort.description}</p>
        </div>
      </div>
      <ul>
        <PrimaryRow
          name="Model"
          description="First choice for every turn at this effort."
          row={rows[0]}
          providers={providers}
          secretKeys={secretKeys}
          emptySpec="Pricing not looked up yet."
          onChange={onOpenPrimary}
        />
      </ul>
      {standbys.length > 0 ? (
        <ol className="border-t border-border">
          {standbys.map((row, i) => {
            const index = i + 1;
            return (
              <ChainRow
                key={row.uid}
                row={row}
                index={index}
                total={rows.length}
                providers={providers}
                secretKeys={secretKeys}
                profileId={profileIdFor(effort.preset, index)}
                onEdit={() => onEditStandby(row)}
                onMove={(delta) => onMoveStandby(index, delta)}
                onRemove={() => onRemoveStandby(row)}
              />
            );
          })}
        </ol>
      ) : null}
      <div className="flex justify-end border-t border-border px-4 py-2">
        <Button variant="ghost" size="sm" onClick={onAddStandby}>
          <Plus aria-hidden /> Add standby
        </Button>
      </div>
    </section>
  );
}

function EmbeddingCard({
  rows,
  providers,
  secretKeys,
  onOpenPrimary,
  onAddStandby,
  onEditStandby,
  onMoveStandby,
  onRemoveStandby,
}: {
  rows: EmbeddingRow[];
  providers: LlmProviderInfo[];
  secretKeys: string[];
  onOpenPrimary: () => void;
  onAddStandby: () => void;
  onEditStandby: (row: EmbeddingRow) => void;
  onMoveStandby: (index: number, delta: number) => void;
  onRemoveStandby: (row: EmbeddingRow) => void;
}) {
  const primary = rows[0];
  const standbys = rows.slice(1);
  return (
    <section className="overflow-hidden rounded-md border border-border">
      <div className="border-b border-border px-4 py-2.5">
        <h4 className="text-sm font-medium text-foreground">Embedding</h4>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Turns Knowledge into vectors so search can match meaning, not just wording.
        </p>
      </div>
      <ul>
        <PrimaryRow
          name="Model"
          description="Used by Knowledge indexing and every retrieval query."
          row={primary}
          providers={providers}
          secretKeys={secretKeys}
          emptySpec="Pricing not looked up yet."
          meta={
            primary?.dimension ? (
              <p className="mt-2 text-xs text-muted-foreground">
                <span>Vector width </span>
                <span className="tabular-nums text-foreground">{primary.dimension}</span>
              </p>
            ) : null
          }
          onChange={onOpenPrimary}
        />
      </ul>
      <p className="border-t border-border px-4 py-2 text-xs text-status-warning">
        {primary
          ? "Changing this model or its width leaves existing vectors unmatchable. Re-index Knowledge after saving."
          : "Knowledge search is running on keyword matching until a model is set."}
      </p>
      {standbys.length > 0 ? (
        <ol className="border-t border-border">
          {standbys.map((row, i) => {
            const index = i + 1;
            return (
              <ChainRow
                key={row.uid}
                row={row}
                index={index}
                total={rows.length}
                providers={providers}
                secretKeys={secretKeys}
                onEdit={() => onEditStandby(row)}
                onMove={(delta) => onMoveStandby(index, delta)}
                onRemove={() => onRemoveStandby(row)}
              />
            );
          })}
        </ol>
      ) : null}
      <div className="flex justify-end border-t border-border px-4 py-2">
        <Button variant="ghost" size="sm" onClick={onAddStandby}>
          <Plus aria-hidden /> Add standby
        </Button>
      </div>
    </section>
  );
}

/**
 * One card per effort (plus one for embeddings), each showing its first-choice model and its
 * standby chain inline. The Advanced tab *is* the disclosure now, so this renders flat rather than
 * behind its own collapse.
 */
export function AdvancedPanel({
  hasChains,
  chains,
  embeddings,
  providers,
  secretKeys,
  defaultEffort,
  onSetDefaultEffort,
  onOpenPrimary,
  onAddChainRow,
  onEditChainRow,
  onMoveChainRow,
  onRemoveChainRow,
  onOpenPrimaryEmbedding,
  onAddEmbedding,
  onEditEmbedding,
  onMoveEmbedding,
  onRemoveEmbedding,
}: {
  hasChains: boolean;
  chains: Chains;
  embeddings: EmbeddingRow[];
  providers: LlmProviderInfo[];
  secretKeys: string[];
  defaultEffort: EffortKey;
  onSetDefaultEffort: (effort: EffortKey) => void;
  onOpenPrimary: (tier: WireTier) => void;
  onAddChainRow: (tier: WireTier) => void;
  onEditChainRow: (tier: WireTier, row: Row) => void;
  onMoveChainRow: (tier: WireTier, index: number, delta: number) => void;
  onRemoveChainRow: (tier: WireTier, row: Row) => void;
  onOpenPrimaryEmbedding: () => void;
  onAddEmbedding: () => void;
  onEditEmbedding: (row: EmbeddingRow) => void;
  onMoveEmbedding: (index: number, delta: number) => void;
  onRemoveEmbedding: (row: EmbeddingRow) => void;
}) {
  const defaultGroup = useId();
  return (
    <div className="space-y-4">
      {hasChains ? (
        EFFORTS.map((effort) => (
          <EffortCard
            key={effort.wire}
            effort={effort}
            rows={chains[effort.wire]}
            providers={providers}
            secretKeys={secretKeys}
            isDefault={defaultEffort === effort.preset}
            defaultGroup={defaultGroup}
            onSetDefault={() => onSetDefaultEffort(effort.preset)}
            onOpenPrimary={() => onOpenPrimary(effort.wire)}
            onAddStandby={() => onAddChainRow(effort.wire)}
            onEditStandby={(row) => onEditChainRow(effort.wire, row)}
            onMoveStandby={(index, delta) => onMoveChainRow(effort.wire, index, delta)}
            onRemoveStandby={(row) => onRemoveChainRow(effort.wire, row)}
          />
        ))
      ) : (
        <p className="text-sm text-muted-foreground">
          This workspace maps effort presets straight to profiles without declaring chains here, so
          there are no standbys to order. Ask in chat to set them up.
        </p>
      )}

      <EmbeddingCard
        rows={embeddings}
        providers={providers}
        secretKeys={secretKeys}
        onOpenPrimary={onOpenPrimaryEmbedding}
        onAddStandby={onAddEmbedding}
        onEditStandby={onEditEmbedding}
        onMoveStandby={onMoveEmbedding}
        onRemoveStandby={onRemoveEmbedding}
      />
    </div>
  );
}
