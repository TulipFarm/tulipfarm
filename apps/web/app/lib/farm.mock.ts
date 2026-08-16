import { CROPS, type CropKind, countsFor, type FarmState, type Planting } from "~/lib/farm";

/**
 * A pretend farm, for looking at the field before a business has planted anything.
 *
 * This exists because `/farm` is honest by design — it can only draw artifacts that really exist,
 * so a fresh instance has nothing to look at and no way to review the visuals. It is reachable
 * only from `?mock=N` on a dev build, and the page labels itself when it is on.
 *
 * Never import this from the real load path.
 */

const NAMES: Record<CropKind, readonly string[]> = {
  resource: ["Customer", "Ticket", "Invoice", "Order", "Lead", "Contract", "Shipment", "Refund"],
  agent: ["Support", "Triage", "Billing", "Onboarding", "Research", "Reviewer", "Scheduler"],
  skill: ["Summarise thread", "Draft reply", "Tag ticket", "Extract fields", "Score lead"],
  routine: ["Nightly digest", "Escalation sweep", "Dunning run", "Weekly report", "Stale check"],
  integration: ["Slack", "GitHub", "Stripe", "Linear", "Notion", "Zendesk", "HubSpot"],
  space: ["Handbook", "Product docs", "Pricing", "Runbooks", "Policies", "FAQ", "Changelog"],
};

/** Round-robin across crops, so one tulip is one resource and six is one of every kind. */
export function mockPlantings(count: number): Planting[] {
  const plantings: Planting[] = [];
  for (let i = 0; i < count; i++) {
    const crop = CROPS[i % CROPS.length];
    if (!crop) continue;
    const nth = Math.floor(i / CROPS.length);
    const pool = NAMES[crop.kind];
    const base = pool[nth % pool.length] ?? crop.singular;
    const name = nth < pool.length ? base : `${base} ${Math.floor(nth / pool.length) + 1}`;
    plantings.push({
      id: `mock:${crop.kind}:${nth}`,
      kind: crop.kind,
      name,
      detail: crop.kind === "resource" ? `${(nth + 3) * 7} records` : undefined,
      href: crop.to,
      // Every third routine sits dormant, so the closed-bud head shows up in the preview.
      bloomed: crop.kind !== "routine" || nth % 3 !== 2,
    });
  }
  return plantings;
}

export function mockFarm(count: number): FarmState {
  const plantings = mockPlantings(Math.max(0, Math.min(count, 400)));
  return { plantings, counts: countsFor(plantings), total: plantings.length, failed: [] };
}

/** Reads `?mock=N`. Returns null off a dev build, so production can never reach the pretend farm. */
export function mockCountFromUrl(url: string): number | null {
  if (!import.meta.env.DEV) return null;
  const raw = new URL(url).searchParams.get("mock");
  if (raw === null) return null;
  const count = Number.parseInt(raw, 10);
  return Number.isFinite(count) && count >= 0 ? count : null;
}
