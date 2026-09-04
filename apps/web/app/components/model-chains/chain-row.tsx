import type { ReactNode } from "react";
import { ArrowDown, ArrowUp, KeyRound, Trash2 } from "~/components/icons";
import {
  capabilityLabels,
  isEntryReady,
  providerLabel,
  type Row,
  specFacts,
} from "~/components/model-chains/chain-data";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Link } from "~/components/ui/link";
import { Panel } from "~/components/ui/panel";
import type { LlmProviderInfo, ModelSpec } from "~/lib/settings";

export function NoProvidersPanel() {
  return (
    <Panel className="border-status-warning/40">
      <div className="flex items-start gap-3">
        <KeyRound className="mt-0.5 size-5 shrink-0 text-status-warning" aria-hidden="true" />
        <div className="min-w-0 space-y-2">
          <p className="text-sm font-medium text-foreground">No provider is configured yet</p>
          <p className="text-sm text-muted-foreground">
            Nothing on this page can answer a turn until at least one provider has its credentials
            stored. Add the credential, then come back.
          </p>
          <Button asChild variant="outline" size="sm">
            <Link to="/business/secrets">Add provider credentials</Link>
          </Button>
        </div>
      </div>
    </Panel>
  );
}

/** Pricing and limits, each number named by the thing it measures. */
function SpecFacts({ spec, empty }: { spec: ModelSpec | undefined; empty: string }) {
  const facts = specFacts(spec);
  const capabilities = capabilityLabels(spec);

  if (facts.length === 0 && capabilities.length === 0) {
    return <p className="mt-2 text-xs text-muted-foreground">{empty}</p>;
  }

  return (
    <div className="mt-2 space-y-2">
      {facts.length > 0 ? (
        <dl className="flex flex-wrap gap-x-5 gap-y-1">
          {facts.map((fact) => (
            <div key={fact.term} className="flex items-baseline gap-1.5">
              <dt className="text-xs text-muted-foreground">{fact.term}</dt>
              <dd className="text-xs tabular-nums text-foreground">{fact.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {capabilities.length > 0 ? (
        <ul className="flex flex-wrap gap-1">
          {capabilities.map((capability) => (
            <li key={capability}>
              <Badge>{capability}</Badge>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/**
 * The model backing one named job — an effort, or embedding. The job is the left column and the
 * model the right, so what the reader is choosing *for* stays legible without decoding a model id.
 */
export function PrimaryRow({
  name,
  description,
  row,
  providers,
  secretKeys,
  emptySpec,
  meta,
  onChange,
}: {
  name: string;
  description: string;
  row: Row | undefined;
  providers: LlmProviderInfo[];
  secretKeys: string[];
  emptySpec: string;
  meta?: ReactNode;
  onChange: () => void;
}) {
  const ready = isEntryReady(providers, secretKeys, row?.provider);

  return (
    <li className="grid gap-x-6 gap-y-3 border-b border-border px-4 py-4 last:border-b-0 sm:grid-cols-[11rem_minmax(0,1fr)_auto] sm:items-start">
      <div className="min-w-0">
        <h3 className="text-sm font-medium text-foreground">{name}</h3>
        <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
      </div>

      <div className="min-w-0">
        {row ? (
          <>
            <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="break-all font-mono text-sm text-foreground">{row.model}</span>
              {ready ? null : <Badge variant="warning">No credential</Badge>}
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {providerLabel(providers, row.provider)}
            </p>
            <SpecFacts spec={row.spec} empty={emptySpec} />
            {meta}
          </>
        ) : (
          <p className="text-sm text-muted-foreground">Not set.</p>
        )}
      </div>

      <Button
        variant="outline"
        size="sm"
        onClick={onChange}
        aria-label={row ? `Change the ${name} model` : `Choose a ${name} model`}
        className="justify-self-start"
      >
        {row ? "Change" : "Choose"}
      </Button>
    </li>
  );
}

/**
 * One entry inside an ordered chain. Compact by design: this lives in Advanced, where the reader
 * has already accepted that order is the point.
 */
export function ChainRow({
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
  profileId?: string;
  onEdit: () => void;
  onMove: (delta: number) => void;
  onRemove: () => void;
}) {
  const ready = isEntryReady(providers, secretKeys, row.provider);
  const label = row.model || "empty entry";

  return (
    <li className="flex items-center gap-3 border-b border-border px-4 py-2.5 last:border-b-0">
      <span
        className="w-5 shrink-0 text-center text-xs tabular-nums text-muted-foreground"
        aria-hidden="true"
      >
        {index + 1}
      </span>

      <button
        type="button"
        onClick={onEdit}
        aria-label={`Edit ${label}`}
        className="min-w-0 flex-1 rounded-sm text-left focus-visible:-outline-offset-2"
      >
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="font-mono text-sm text-foreground">{row.model || "no model set"}</span>
          <span className="text-xs text-muted-foreground">
            {providerLabel(providers, row.provider) || "No provider"}
          </span>
          {index === 0 ? <Badge>First choice</Badge> : null}
          {ready ? null : <Badge variant="warning">No credential</Badge>}
        </span>
        {profileId ? (
          <span className="mt-0.5 block font-mono text-xs text-muted-foreground">{profileId}</span>
        ) : null}
      </button>

      <div className="flex shrink-0 items-center gap-0.5">
        <Button
          variant="ghost"
          size="icon"
          className="size-8"
          disabled={index === 0}
          onClick={() => onMove(-1)}
          aria-label={`Move ${label} earlier`}
        >
          <ArrowUp aria-hidden />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-8"
          disabled={index === total - 1}
          onClick={() => onMove(1)}
          aria-label={`Move ${label} later`}
        >
          <ArrowDown aria-hidden />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-8 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
          onClick={onRemove}
          aria-label={`Remove ${label}`}
        >
          <Trash2 aria-hidden />
        </Button>
      </div>
    </li>
  );
}
