import { describe, expect, test } from "vitest";
import { CROPS } from "~/lib/farm";
import { mockCountFromUrl, mockFarm } from "~/lib/farm.mock";

describe("mockFarm", () => {
  test("plants one resource for the first tulip", () => {
    const farm = mockFarm(1);
    expect(farm.total).toBe(1);
    expect(farm.plantings[0]?.kind).toBe("resource");
    expect(farm.counts.resource).toBe(1);
  });

  test("gives one of every crop at six, so the legend fills evenly", () => {
    const farm = mockFarm(CROPS.length);
    for (const crop of CROPS) expect(farm.counts[crop.kind]).toBe(1);
  });

  test("keeps ids unique and stable, so the field does not reshuffle between renders", () => {
    const ids = mockFarm(40).plantings.map((planting) => planting.id);
    expect(new Set(ids).size).toBe(40);
    expect(mockFarm(40).plantings.map((planting) => planting.id)).toEqual(ids);
  });

  test("shows dormant routines, so the closed-bud head appears in the preview", () => {
    const farm = mockFarm(40);
    const routines = farm.plantings.filter((planting) => planting.kind === "routine");
    expect(routines.some((planting) => !planting.bloomed)).toBe(true);
    expect(routines.some((planting) => planting.bloomed)).toBe(true);
  });
});

describe("mockCountFromUrl", () => {
  test("reads a count only when the parameter is there", () => {
    expect(mockCountFromUrl("http://x/farm")).toBeNull();
    expect(mockCountFromUrl("http://x/farm?mock=12")).toBe(12);
    expect(mockCountFromUrl("http://x/farm?mock=0")).toBe(0);
  });

  test("ignores junk rather than rendering a broken field", () => {
    expect(mockCountFromUrl("http://x/farm?mock=lots")).toBeNull();
    expect(mockCountFromUrl("http://x/farm?mock=-4")).toBeNull();
  });
});
