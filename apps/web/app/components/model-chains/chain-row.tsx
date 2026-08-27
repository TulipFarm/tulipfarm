import { Link } from "@remix-run/react";
import { ArrowDown, ArrowUp, KeyRound, Trash2 } from "lucide-react";
import { providerLabel, type Row, specFacts } from "~/components/model-chains/chain-data";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Panel } from "~/components/ui/panel";
import { isProviderConfigured, type LlmProviderInfo } from "~/lib/settings";

export function NoProvidersPanel() {
  return (
    <Panel className="border-status-warning/40">
      <div className="flex items-start gap-3">
        <KeyRound className="mt-0.5 size-5 shrink-0 text-status-warning" aria-hidden="true" />
        <div className="min-w-0 space-y-2">
          <p className="text-sm font-medium text-foreground">No provider is configured yet</p>
          <p className="text-sm text-muted-foreground">
            Every chain below will fail until at least one provider has its credentials stored.
            Nothing here needs to change first. Add the credential, then come back.
          </p>
          <Button asChild variant="outline" size="sm">
            <Link to="/business/secrets">Add provider credentials</Link>
          </Button>
        </div>
      </div>
    </Panel>
  );
}

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
