import { GuideSection } from "~/components/design-guide/guide-section";

const TOKENS = [
  ["Background", "bg-background"],
  ["Card", "bg-card"],
  ["Secondary", "bg-secondary"],
  ["Muted", "bg-muted"],
  ["Accent", "bg-accent"],
  ["Primary", "bg-primary"],
  ["Brand", "bg-brand"],
  ["Destructive", "bg-destructive"],
] as const;

/**
 * A Run that failed and a Record marked "blocked" are unrelated facts, so they never share a
 * tone.
 */
const RUN_TOKENS = [
  ["run-pending", "bg-run-pending"],
  ["run-active", "bg-run-active"],
  ["run-ok", "bg-run-ok"],
  ["run-error", "bg-run-error"],
  ["run-blocked", "bg-run-blocked"],
  ["run-skipped", "bg-run-skipped"],
] as const;

/**
 * Categorical encoding for charts and series. Never chrome, never status, never brand.
 * 9 and 10 are the quiet tail, reserved for residual buckets so "Other" cannot outshout a
 * real category.
 */
const DATA_TOKENS = [
  ["data-1", "bg-data-1"],
  ["data-2", "bg-data-2"],
  ["data-3", "bg-data-3"],
  ["data-4", "bg-data-4"],
  ["data-5", "bg-data-5"],
  ["data-6", "bg-data-6"],
  ["data-7", "bg-data-7"],
  ["data-8", "bg-data-8"],
  ["data-9", "bg-data-9"],
  ["data-10", "bg-data-10"],
] as const;

/** Filled chips and callout banners: each tone paired with its own ground and hairline. */
const TINT_TOKENS = [
  ["neutral", "bg-status-neutral-surface", "text-status-neutral", "border-status-neutral"],
  ["info", "bg-status-info-surface", "text-status-info", "border-status-info"],
  ["success", "bg-status-success-surface", "text-status-success", "border-status-success"],
  ["warning", "bg-status-warning-surface", "text-status-warning", "border-status-warning"],
  ["danger", "bg-status-danger-surface", "text-status-danger", "border-status-danger"],
] as const;

/** Sequential magnitude, low to high. Ordered and comparable, which `data-*` must never be. */
const HEAT_TOKENS = [
  ["heat-1", "bg-heat-1", "text-heat-ink"],
  ["heat-2", "bg-heat-2", "text-heat-ink"],
  ["heat-3", "bg-heat-3", "text-heat-ink"],
  ["heat-4", "bg-heat-4", "text-heat-ink-peak"],
] as const;

/** Which layer a Tool belongs to. Tints the glyph so a system call never reads as an outbound one. */
const TIER_TOKENS = [
  ["system", "bg-tool-tier-system"],
  ["platform", "bg-tool-tier-platform"],
  ["integration", "bg-tool-tier-integration"],
  ["mutating", "bg-tool-mutating"],
] as const;

export function ColorSections() {
  return (
    <>
      <GuideSection
        id="tokens"
        title="Design tokens"
        description="Semantic surfaces adapt to the active light or dark theme."
      >
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {TOKENS.map(([label, color]) => (
            <div key={label} className="overflow-hidden rounded-md border border-border">
              <div className={`h-16 ${color}`} />
              <div className="border-t border-border bg-background px-3 py-2 text-sm">{label}</div>
            </div>
          ))}
        </div>
      </GuideSection>

      <GuideSection
        id="run-tokens"
        title="Run & data palettes"
        description="Execution state and categorical data are separate token families. Run tones report what a Run did; data tones encode series and never appear in chrome, status, or brand."
      >
        <h3 className="mb-2 text-sm font-medium">Run state</h3>
        <div className="mb-6 grid gap-2 sm:grid-cols-3 lg:grid-cols-6">
          {RUN_TOKENS.map(([label, color]) => (
            <div key={label} className="overflow-hidden rounded-md border border-border">
              <div className={`h-10 ${color}`} />
              <div className="border-t border-border bg-background px-2 py-1.5 font-mono text-xs">
                {label}
              </div>
            </div>
          ))}
        </div>

        <h3 className="mb-2 text-sm font-medium">Tool identity</h3>
        <div className="mb-6 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          {TIER_TOKENS.map(([label, color]) => (
            <div key={label} className="overflow-hidden rounded-md border border-border">
              <div className={`h-10 ${color}`} />
              <div className="border-t border-border bg-background px-2 py-1.5 font-mono text-xs">
                {label}
              </div>
            </div>
          ))}
        </div>

        <h3 className="mb-2 text-sm font-medium">Categorical data</h3>
        <div className="mb-6 grid gap-2 sm:grid-cols-4 lg:grid-cols-10">
          {DATA_TOKENS.map(([label, color]) => (
            <div key={label} className="overflow-hidden rounded-md border border-border">
              <div className={`h-10 ${color}`} />
              <div className="border-t border-border bg-background px-2 py-1.5 font-mono text-xs">
                {label}
              </div>
            </div>
          ))}
        </div>

        <h3 className="mb-2 text-sm font-medium">Tinted grounds</h3>
        <div className="mb-6 flex flex-wrap gap-2">
          {TINT_TOKENS.map(([label, surface, ink, edge]) => (
            <span
              key={label}
              className={`rounded-md border px-2.5 py-1 font-mono text-xs ${surface} ${ink} ${edge}`}
            >
              status-{label}
            </span>
          ))}
        </div>

        <h3 className="mb-2 text-sm font-medium">Sequential magnitude</h3>
        <div className="grid gap-2 sm:grid-cols-4">
          {HEAT_TOKENS.map(([label, surface, ink]) => (
            <div key={label} className="overflow-hidden rounded-md border border-border">
              <div
                className={`flex h-10 items-center justify-center font-mono text-xs ${surface} ${ink}`}
              >
                {label}
              </div>
            </div>
          ))}
        </div>
      </GuideSection>
    </>
  );
}
