import { GuideSection } from "~/components/design-guide/guide-section";
import { CropLegend, SeasonStrip } from "~/components/farm/farm-summary";
import { TulipField } from "~/components/farm/tulip-field";
import { CROPS, type CropKind, countsFor, cropFor, farmSeason, type Planting } from "~/lib/farm";

/*
 * Specimen plantings only — the components below are the production ones, so this section cannot
 * drift from what /farm renders.
 */
const SPECIMENS: Planting[] = [
  ...CROPS.flatMap((crop, cropIndex) =>
    Array.from({ length: 3 + cropIndex }, (_, i) => ({
      id: `${crop.kind}:specimen-${i}`,
      kind: crop.kind,
      name: `${crop.singular} ${i + 1}`,
      href: crop.to,
      // One dormant specimen per crop that has a dormant state, so both heads are on show.
      bloomed: !(crop.dormantMeans && i === 0),
    }))
  ),
];

/** Walks a farm from bare soil to every crop growing, so each season name has a real example. */
const SEASON_LADDER = Array.from({ length: CROPS.length + 1 }, (_, i) =>
  CROPS.slice(0, i).map((crop) => crop.kind)
);

const specimen = (kind: CropKind): Planting => ({
  id: `ladder:${kind}`,
  kind,
  name: kind,
  href: cropFor(kind).to,
  bloomed: true,
});

export function FarmSections() {
  return (
    <GuideSection
      id="farm"
      title="Farm: the tulip field"
      description="One Soul artifact, one tulip, typed into a field. The tulip is the mono glyph the docs home page draws, (@) on a | stem with a / leaf, so it reads as a mark rather than as a bad likeness of a flower. Colour carries kind from the categorical data palette, the bed groups each kind into a stripe of its real width, the head carries whether the thing can actually act, and growth carries arrival. The same 'motion reports real state' contract the onboarding tulip works to. The canvas is aria-hidden, so the legend beneath it is the field's accessible counterpart, not an extra."
    >
      <div className="flex flex-col gap-6">
        <div>
          <h3 className="mb-2 text-sm font-medium">Crop colours</h3>
          <ul className="flex flex-wrap gap-2">
            {CROPS.map((crop) => (
              <li
                key={crop.kind}
                className="flex items-center gap-2 rounded-md border border-border px-2.5 py-1.5 text-xs"
              >
                <span
                  aria-hidden
                  className="size-2 rounded-full"
                  style={{ backgroundColor: `var(${crop.colorVar})` }}
                />
                <span className="font-medium">{crop.label}</span>
                <code className="font-mono text-[0.6875rem] text-muted-foreground">
                  {crop.colorVar}
                </code>
              </li>
            ))}
          </ul>
        </div>

        <div>
          <h3 className="mb-2 text-sm font-medium">Head states</h3>
          <ul className="flex flex-col gap-1 text-base text-muted-foreground">
            <li>
              <code className="font-mono text-foreground">(@)</code>, an open bloom. The artifact
              can act.
            </li>
            <li>
              <code className="font-mono text-foreground">@</code>. A closed bud. It exists but
              nothing can start it:{" "}
              {CROPS.filter((crop) => crop.dormantMeans)
                .map((crop) => crop.dormantMeans)
                .join(", ")}
              . Kinds with no such distinction always bloom rather than being given a fake dormancy.
            </li>
            <li>
              <code className="font-mono text-foreground">|</code> and{" "}
              <code className="font-mono text-foreground">/</code>: stem and leaf, both in the stem
              colour. Only the head is ever coloured, so a glance across the field counts kinds.
            </li>
          </ul>
        </div>

        <div>
          <h3 className="mb-2 text-sm font-medium">Ground</h3>
          <ul className="flex flex-col gap-1 text-base text-muted-foreground">
            <li>
              <span className="text-foreground">Beds</span>, one contiguous stripe per kind, as wide
              as that kind's real share of the farm, in the palette order above.
            </li>
            <li>
              <span className="text-foreground">Footprint</span>, the planted patch widens as the
              farm fills, so a new instance shows bare ground around a few plants and a mature one
              carpets the frame.
            </li>
            <li>
              <span className="text-foreground">Depth</span>, every glyph in a field is set at one
              size, because ASCII reads as ASCII only when the character cell is constant. Distance
              is spent on shorter stems, fainter ink and a tighter pitch instead.
            </li>
            <li>
              <span className="text-foreground">Soil</span>, a scatter of{" "}
              <code className="font-mono">, . ' `</code> along each row. There is no painted plane;
              the page background is the field.
            </li>
            <li>
              <span className="text-foreground">Skyline</span>: a treeline, a windmill and a barn
              stand above the tallest bloom in the muted ground ink, never in a crop colour, so
              nothing there can be mistaken for an artifact. The barn carries the instance's own
              business name and goes unsigned rather than invented when there is none, the sails
              turn only while something is planted, and the whole farmstead is dropped when the crop
              leaves no skyline to build on.
            </li>
          </ul>
        </div>

        <div>
          <h3 className="mb-2 text-sm font-medium">Seasons</h3>
          <p className="mb-2 text-base text-muted-foreground">
            Named by how much of the crop catalog the farm actually grows, so the denominator is a
            real one. Size alone earns no title.
          </p>
          <ul className="flex flex-wrap gap-2">
            {SEASON_LADDER.map((kinds) => {
              const season = farmSeason(countsFor(kinds.map(specimen)));
              return (
                <li
                  key={season.crops}
                  className="rounded-md border border-border px-2.5 py-1.5 font-mono text-xs"
                >
                  <span className="text-muted-foreground">
                    {season.crops}/{season.ofCrops}
                  </span>{" "}
                  <span className="text-foreground">{season.name}</span>
                </li>
              );
            })}
          </ul>
        </div>

        <div className="overflow-hidden rounded-md border border-border">
          <SeasonStrip season={farmSeason(countsFor(SPECIMENS))} total={SPECIMENS.length} />
          <div className="h-64">
            <TulipField plantings={SPECIMENS} farmName="Specimen Farm" />
          </div>
          <CropLegend counts={countsFor(SPECIMENS)} failed={[]} />
        </div>
      </div>
    </GuideSection>
  );
}
