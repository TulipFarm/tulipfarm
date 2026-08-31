import { useId } from "react";
import {
  EFFORTS,
  type EffortKey,
  formatTokens,
  isEntryReady,
  perMtok,
  providerLabel,
  type Row,
  type WireTier,
} from "~/components/model-chains/chain-data";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import type { LlmProviderInfo } from "~/lib/settings";

/**
 * A cell whose number is missing is not blank: an operator reading a blank cost column concludes
 * the model is free. It offers the way to fill it in instead.
 */
function MoneyCell({
  cost,
  onSet,
  label,
}: {
  cost: number | undefined;
  onSet: () => void;
  label: string;
}) {
  if (cost != null) {
    return (
      <td className="px-3 py-3 text-right align-top text-sm tabular-nums text-foreground">
        {perMtok(cost)}
      </td>
    );
  }
  return (
    <td className="px-3 py-3 text-right align-top">
      <Button
        variant="ghost"
        size="sm"
        className="-my-1 h-7 px-2"
        onClick={onSet}
        aria-label={label}
      >
        Set
      </Button>
    </td>
  );
}

/**
 * The three efforts as one comparison table, with the default effort chosen from inside it.
 *
 * Cost is the question this page exists to answer and it only answers it if the three rows can be
 * read down a column. The default belongs in the same table rather than in a footer select: it
 * decides what almost every turn costs, so it is a property of a row, not a separate setting that
 * happens to name one.
 */
export function ChatModelsTable({
  chains,
  providers,
  secretKeys,
  defaultEffort,
  onDefaultChange,
  onChange,
}: {
  chains: Record<WireTier, Row[]>;
  providers: LlmProviderInfo[];
  secretKeys: string[];
  /** Undefined when the default points at a profile only Advanced can name. */
  defaultEffort: EffortKey | undefined;
  onDefaultChange: (effort: EffortKey) => void;
  onChange: (tier: WireTier, focus?: "pricing") => void;
}) {
  const group = useId();

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[44rem] border-separate border-spacing-0 text-sm">
        <thead>
          <tr>
            <th
              scope="col"
              className="border-b border-border px-3 py-2 text-left text-xs font-medium text-muted-foreground"
            >
              Default
            </th>
            <th
              scope="col"
              className="border-b border-border px-3 py-2 text-left text-xs font-medium text-muted-foreground"
            >
              Effort
            </th>
            <th
              scope="col"
              className="border-b border-border px-3 py-2 text-left text-xs font-medium text-muted-foreground"
            >
              Model
            </th>
            <th
              scope="col"
              className="border-b border-border px-3 py-2 text-right text-xs font-medium text-muted-foreground"
            >
              Input / 1M
            </th>
            <th
              scope="col"
              className="border-b border-border px-3 py-2 text-right text-xs font-medium text-muted-foreground"
            >
              Output / 1M
            </th>
            <th className="border-b border-border px-3 py-2">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody className="[&>tr:last-child>td]:border-b-0 [&>tr>td]:border-b [&>tr>td]:border-border">
          {EFFORTS.map((effort) => {
            const rows = chains[effort.wire];
            const row = rows[0];
            const standbys = Math.max(rows.length - 1, 0);
            const ready = isEntryReady(providers, secretKeys, row?.provider);
            const spec = row?.spec;
            const isDefault = defaultEffort === effort.preset;

            return (
              <tr
                key={effort.wire}
                className={isDefault ? "bg-accent/30" : "transition-colors hover:bg-accent/20"}
              >
                <td className="px-3 py-3 align-top">
                  <input
                    type="radio"
                    name={group}
                    checked={isDefault}
                    onChange={() => onDefaultChange(effort.preset)}
                    aria-label={`Make ${effort.label} the default effort`}
                    className="mt-0.5 size-4 accent-primary"
                  />
                </td>

                <td className="px-3 py-3 align-top">
                  <p className="font-medium text-foreground">{effort.label}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">{effort.description}</p>
                </td>

                <td className="px-3 py-3 align-top">
                  {row ? (
                    <>
                      <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <span className="break-all font-mono text-sm text-foreground">
                          {row.model}
                        </span>
                        {ready ? null : <Badge variant="warning">No credential</Badge>}
                      </p>
                      {/* Context sits here rather than in its own column: it is usually the same
                          across all three efforts, so a column of it carries no comparison. */}
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {[
                          providerLabel(providers, row.provider),
                          spec?.max_input_tokens
                            ? `${formatTokens(spec.max_input_tokens)} context`
                            : null,
                          standbys > 0 ? `${standbys} standby${standbys === 1 ? "" : "s"}` : null,
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </p>
                    </>
                  ) : (
                    <span className="text-sm text-muted-foreground">Not set</span>
                  )}
                </td>

                <MoneyCell
                  cost={spec?.input_cost_per_token}
                  onSet={() => onChange(effort.wire, "pricing")}
                  label={`Set the ${effort.label} input price`}
                />
                <MoneyCell
                  cost={spec?.output_cost_per_token}
                  onSet={() => onChange(effort.wire, "pricing")}
                  label={`Set the ${effort.label} output price`}
                />

                <td className="px-3 py-3 text-right align-top">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => onChange(effort.wire)}
                    aria-label={
                      row ? `Change the ${effort.label} model` : `Choose a ${effort.label} model`
                    }
                  >
                    {row ? "Change" : "Choose"}
                  </Button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
