import { Link } from "@remix-run/react";
import { CROPS, type CropKind, cropFor, type Season } from "~/lib/farm";

/**
 * Names the farm by how much of the crop catalog it grows. The denominator is the number of kinds
 * that exist, so the progress it shows is a real one and not a quota the page invented.
 */
export function SeasonStrip({ season, total }: { season: Season; total: number }) {
  const filled = season.crops / season.ofCrops;
  const nextCrop = season.missing[0];

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border px-6 py-3 md:px-8">
      <h1 className="text-sm font-semibold text-foreground">{season.name}</h1>
      <p className="font-mono text-xs tabular-nums text-muted-foreground">
        {total} {total === 1 ? "tulip" : "tulips"}
      </p>
      <div className="ml-auto flex min-w-0 items-center gap-3">
        <p className="truncate text-xs text-muted-foreground">
          {nextCrop
            ? `${season.crops} of ${season.ofCrops} crops · nothing in ${cropFor(nextCrop).label.toLowerCase()} yet`
            : `All ${season.ofCrops} crops growing`}
        </p>
        <div aria-hidden className="h-1 w-20 shrink-0 rounded-full bg-muted">
          <div
            className="h-full rounded-full bg-tulip-stem transition-[width] duration-500"
            style={{ width: `${Math.round(filled * 100)}%` }}
          />
        </div>
      </div>
    </div>
  );
}

/**
 * The legend, and the field's accessible counterpart. The canvas is `aria-hidden`, so this is the
 * surface that publishes what is growing and how to reach it — by keyboard, by reader, and on the
 * touch layouts where hovering a tulip is not available.
 */
export function CropLegend({
  counts,
  failed,
}: {
  counts: Record<CropKind, number>;
  failed: readonly CropKind[];
}) {
  return (
    <ul className="flex flex-wrap items-stretch gap-2 border-t border-border px-6 py-3 md:px-8">
      {CROPS.map((crop) => {
        const count = counts[crop.kind];
        const unavailable = failed.includes(crop.kind);
        return (
          <li key={crop.kind}>
            <Link
              to={crop.to}
              className="flex items-center gap-2 rounded-md border border-border px-2.5 py-1.5 text-xs transition-colors duration-150 hover:bg-accent"
            >
              <span
                aria-hidden
                className="size-2 shrink-0 rounded-full"
                style={{ backgroundColor: `var(${crop.colorVar})` }}
              />
              <span className="font-medium text-foreground">{crop.label}</span>
              <span className="font-mono tabular-nums text-muted-foreground">
                {unavailable ? "-" : count}
              </span>
              {unavailable ? <span className="sr-only">could not be loaded</span> : null}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
