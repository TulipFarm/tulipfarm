import { useId } from "react";
import { ChevronRight, Plus } from "~/components/icons";
import {
  EFFORTS,
  type EmbeddingRow,
  PRESET_KEYS,
  type PresetKey,
  profileIdFor,
  type Row,
  type WireTier,
} from "~/components/model-chains/chain-data";
import { ChainRow } from "~/components/model-chains/chain-row";
import { Button } from "~/components/ui/button";
import { Field } from "~/components/ui/field";
import { Input } from "~/components/ui/input";
import { PanelEmpty } from "~/components/ui/panel";
import { Select } from "~/components/ui/select";
import type { LlmProviderInfo } from "~/lib/settings";

type Chains = Record<WireTier, Row[]>;
type Presets = Record<PresetKey, string>;

function ChainEditor({
  heading,
  rows,
  providers,
  secretKeys,
  profileId,
  emptyHint,
  addLabel,
  onAdd,
  onEdit,
  onMove,
  onRemove,
}: {
  heading: string;
  rows: Row[];
  providers: LlmProviderInfo[];
  secretKeys: string[];
  profileId?: (index: number) => string;
  emptyHint: string;
  addLabel: string;
  onAdd: () => void;
  onEdit: (row: Row) => void;
  onMove: (index: number, delta: number) => void;
  onRemove: (row: Row) => void;
}) {
  const headingId = useId();

  return (
    <section aria-labelledby={headingId} className="rounded-md border border-border">
      <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-2.5">
        <h4 id={headingId} className="text-sm font-medium text-foreground">
          {heading}
        </h4>
        <Button variant="ghost" size="sm" onClick={onAdd}>
          <Plus aria-hidden /> {addLabel}
        </Button>
      </div>
      {rows.length === 0 ? (
        <PanelEmpty>{emptyHint}</PanelEmpty>
      ) : (
        <ol>
          {rows.map((row, index) => (
            <ChainRow
              key={row.uid}
              row={row}
              index={index}
              total={rows.length}
              providers={providers}
              secretKeys={secretKeys}
              profileId={profileId?.(index)}
              onEdit={() => onEdit(row)}
              onMove={(delta) => onMove(index, delta)}
              onRemove={() => onRemove(row)}
            />
          ))}
        </ol>
      )}
    </section>
  );
}

/**
 * Everything an operator can leave alone. Fallback order and per-effort routing are real controls,
 * but a workspace that never touches them still works, so they must not compete for attention with
 * the choice of model itself.
 */
export function AdvancedPanel({
  hasChains,
  chains,
  embeddings,
  presets,
  profiles,
  providers,
  secretKeys,
  onAddChainRow,
  onEditChainRow,
  onMoveChainRow,
  onRemoveChainRow,
  onAddEmbedding,
  onEditEmbedding,
  onMoveEmbedding,
  onRemoveEmbedding,
  onPresetChange,
  defaultOpen = false,
}: {
  hasChains: boolean;
  chains: Chains;
  embeddings: EmbeddingRow[];
  presets: Presets;
  profiles: { id: string; label: string }[];
  providers: LlmProviderInfo[];
  secretKeys: string[];
  onAddChainRow: (tier: WireTier) => void;
  onEditChainRow: (tier: WireTier, row: Row) => void;
  onMoveChainRow: (tier: WireTier, index: number, delta: number) => void;
  onRemoveChainRow: (tier: WireTier, row: Row) => void;
  onAddEmbedding: () => void;
  onEditEmbedding: (row: EmbeddingRow) => void;
  onMoveEmbedding: (index: number, delta: number) => void;
  onRemoveEmbedding: (row: EmbeddingRow) => void;
  onPresetChange: (key: PresetKey, value: string) => void;
  defaultOpen?: boolean;
}) {
  return (
    <details
      open={defaultOpen}
      className="group overflow-hidden rounded-lg border border-border bg-card"
    >
      {/* The default marker is suppressed so the chevron can carry the state; without one this
          reads as a dead panel rather than something that opens. */}
      <summary className="flex cursor-pointer list-none items-start gap-2 px-4 py-3 transition-colors hover:bg-accent/50 focus-visible:-outline-offset-2">
        <ChevronRight
          aria-hidden
          className="mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform duration-100 group-open:rotate-90"
        />
        <span className="min-w-0">
          <h2 className="text-sm font-semibold text-foreground">Advanced</h2>
          <span className="mt-0.5 block text-sm text-muted-foreground">
            Standby models for when a provider is down, and per-effort routing overrides. Most
            workspaces never need to open this.
          </span>
        </span>
      </summary>

      <div className="space-y-6 border-t border-border p-4">
        <section className="space-y-3">
          <div>
            <h3 className="text-sm font-medium text-foreground">Standby models</h3>
            <p className="mt-1 max-w-prose text-sm text-muted-foreground">
              Tried in order when the one above it is unavailable. The first entry is the model
              shown on this page.
            </p>
          </div>

          {hasChains ? (
            EFFORTS.map((effort) => (
              <ChainEditor
                key={effort.wire}
                heading={effort.label}
                rows={chains[effort.wire]}
                providers={providers}
                secretKeys={secretKeys}
                profileId={(index) => profileIdFor(effort.preset, index)}
                emptyHint={`Nothing configured. ${effort.label} turns will fail until a model is added.`}
                addLabel="Add standby"
                onAdd={() => onAddChainRow(effort.wire)}
                onEdit={(row) => onEditChainRow(effort.wire, row)}
                onMove={(index, delta) => onMoveChainRow(effort.wire, index, delta)}
                onRemove={(row) => onRemoveChainRow(effort.wire, row)}
              />
            ))
          ) : (
            <p className="text-sm text-muted-foreground">
              This workspace maps effort presets straight to profiles without declaring chains here,
              so there are no standbys to order. Ask in chat to set them up.
            </p>
          )}

          <ChainEditor
            heading="Embedding"
            rows={embeddings}
            providers={providers}
            secretKeys={secretKeys}
            emptyHint="No embedding model configured. Knowledge search falls back to keyword matching."
            addLabel="Add standby"
            onAdd={onAddEmbedding}
            onEdit={onEditEmbedding}
            onMove={onMoveEmbedding}
            onRemove={onRemoveEmbedding}
          />
        </section>

        <section className="space-y-3">
          <div>
            <h3 className="text-sm font-medium text-foreground">Effort routing</h3>
            <p className="mt-1 max-w-prose text-sm text-muted-foreground">
              Which profile each effort resolves to. By default an effort routes to its own
              first-choice model; point one elsewhere to send it down another chain.
            </p>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            {PRESET_KEYS.map((key) => (
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
                    onChange={(e) => onPresetChange(key, e.target.value)}
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
                    onChange={(e) => onPresetChange(key, e.target.value)}
                  />
                )}
              </Field>
            ))}
          </div>
        </section>
      </div>
    </details>
  );
}
