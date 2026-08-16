import { describe, expect, test } from "vitest";
import { barnRows, bedsFor, indexSeed, layoutField, rowCount } from "~/components/farm/tulip-field";
import type { CropKind, Planting } from "~/lib/farm";

function plantings(count: number, kind: CropKind = "skill"): Planting[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `${kind}:${kind[0]}${i}`,
    kind,
    name: `${kind}${i}`,
    href: `/${kind}s/${i}`,
    bloomed: true,
  }));
}

describe("rowCount", () => {
  test("deepens the field as the farm fills, up to a ceiling", () => {
    expect(rowCount(0)).toBe(0);
    expect(rowCount(1)).toBe(1);
    expect(rowCount(17)).toBe(4);
    expect(rowCount(60)).toBe(6);
    expect(rowCount(500)).toBe(8);

    // Monotonic, and it never digs past the ceiling however large the farm gets.
    let previous = 0;
    for (const total of [1, 5, 17, 40, 90, 300, 5000]) {
      const rows = rowCount(total);
      expect(rows).toBeGreaterThanOrEqual(previous);
      expect(rows).toBeLessThanOrEqual(8);
      previous = rows;
    }
  });
});

describe("bedsFor", () => {
  test("gives each present kind one bed sized by its real share", () => {
    const mixed = [...plantings(6, "skill"), ...plantings(2, "agent")];
    const beds = bedsFor(mixed);

    expect(beds.map((bed) => bed.kind)).toEqual(["agent", "skill"]);
    expect(beds.map((bed) => bed.count)).toEqual([2, 6]);
    // Beds tile the field edge to edge, in palette order, with no gap between them.
    expect(beds[0]?.from).toBeCloseTo(-0.5);
    expect(beds[0]?.to).toBeCloseTo(beds[1]?.from ?? Number.NaN);
    expect(beds[beds.length - 1]?.to).toBeCloseTo(0.5);
  });

  test("leaves out kinds nothing is planted in", () => {
    expect(bedsFor(plantings(4, "skill")).map((bed) => bed.kind)).toEqual(["skill"]);
  });
});

describe("layoutField", () => {
  test("plants nothing when there is no field or no crop", () => {
    expect(layoutField(plantings(3), 0, 400).stalks).toEqual([]);
    expect(layoutField(plantings(3), 800, 0).stalks).toEqual([]);
    expect(layoutField([], 800, 400).stalks).toEqual([]);
  });

  test("keeps bare ground, so a farm with nothing planted still reads as a field", () => {
    const bare = layoutField([], 800, 400);
    expect(bare.stalks).toEqual([]);
    expect(bare.frontY).toBeGreaterThan(bare.horizonY);
    // The ground still spans the frame, or `makeSoil` has nothing to scatter specks across.
    expect(bare.plantedWidth).toBeGreaterThan(0);
  });

  test("gives every planting exactly one tulip", () => {
    const { stalks } = layoutField(plantings(20), 900, 500);
    expect(stalks).toHaveLength(20);
    expect(new Set(stalks.map((stalk) => stalk.planting.id)).size).toBe(20);
  });

  test("is deterministic, so a farm keeps its shape between visits", () => {
    const shape = (field: ReturnType<typeof layoutField>) =>
      field.stalks.map((s) => [s.planting.id, s.x, s.y, s.scale]);
    expect(shape(layoutField(plantings(12), 900, 500))).toEqual(
      shape(layoutField(plantings(12), 900, 500))
    );
  });

  test("keeps every tulip inside the frame", () => {
    const width = 900;
    const height = 500;
    for (const stalk of layoutField(plantings(30), width, height).stalks) {
      expect(stalk.x).toBeGreaterThan(0);
      expect(stalk.x).toBeLessThan(width);
      expect(stalk.y).toBeGreaterThan(height * 0.1);
      expect(stalk.y).toBeLessThanOrEqual(height);
    }
  });

  test("plants each kind as one stripe rather than scattering it", () => {
    const mixed = [...plantings(8, "skill"), ...plantings(8, "agent")];
    const { stalks } = layoutField(mixed, 900, 500);
    const agents = stalks.filter((s) => s.planting.kind === "agent").map((s) => s.u);
    const skills = stalks.filter((s) => s.planting.kind === "skill").map((s) => s.u);
    // Agents come first in palette order, so their whole bed sits left of every skill.
    expect(Math.max(...agents)).toBeLessThan(Math.min(...skills));
  });

  test("spreads a kind over every row, so a stripe runs away from the viewer", () => {
    const { stalks, rows } = layoutField(plantings(18), 900, 500);
    expect(rows).toBeGreaterThan(1);
    const depths = new Set(stalks.map((stalk) => Math.round(stalk.depth * rows)));
    expect(depths.size).toBe(rows);
  });

  test("sets the whole field at one size, which is what makes it read as ASCII", () => {
    const { stalks, scale } = layoutField(plantings(24), 900, 500);
    expect(scale).toBeGreaterThan(0);
    expect(new Set(stalks.map((stalk) => stalk.scale))).toEqual(new Set([scale]));
  });

  test("shortens and dims stems with distance, which is what reads as depth", () => {
    const { stalks } = layoutField(plantings(24), 900, 500);
    const front = stalks[stalks.length - 1];
    const back = stalks[0];
    expect(back?.depth).toBeGreaterThan(front?.depth ?? 1);
    expect(back?.p).toBeLessThan(front?.p ?? 0);
    expect(back?.rows).toBeLessThan(front?.rows ?? 0);
    expect(back?.y).toBeLessThan(front?.y ?? 0);
  });

  test("never lets a far tulip out-grow a near one, however the hash falls", () => {
    for (const stalk of layoutField(plantings(60), 900, 500).stalks) {
      // 3..4 rows of hash-driven unevenness, plus 0..4 rows of depth, which always wins.
      expect(stalk.rows).toBeGreaterThanOrEqual(3);
      expect(stalk.rows).toBeLessThanOrEqual(8);
    }
    const rowsAtDepth = new Map<number, number[]>();
    for (const stalk of layoutField(plantings(60), 900, 500).stalks) {
      const row = Math.round(stalk.depth * 8);
      rowsAtDepth.set(row, [...(rowsAtDepth.get(row) ?? []), stalk.rows]);
    }
    const nearest = Math.min(...rowsAtDepth.keys());
    const furthest = Math.max(...rowsAtDepth.keys());
    expect(Math.min(...(rowsAtDepth.get(nearest) ?? []))).toBeGreaterThan(
      Math.max(...(rowsAtDepth.get(furthest) ?? []))
    );
  });

  test("draws back to front, so near tulips overlap the far ones", () => {
    const depths = layoutField(plantings(40), 900, 500).stalks.map((stalk) => stalk.depth);
    expect(depths).toEqual([...depths].sort((a, b) => b - a));
  });

  test("widens the planted patch as the farm grows, then stops at the frame", () => {
    const width = 900;
    const small = layoutField(plantings(4), width, 500).plantedWidth;
    const medium = layoutField(plantings(24), width, 500).plantedWidth;
    const large = layoutField(plantings(200), width, 500).plantedWidth;

    expect(small).toBeLessThan(medium);
    expect(medium).toBeLessThanOrEqual(large);
    expect(large).toBeLessThanOrEqual(width);
  });

  test("gives a sparse farm showcase blooms and a full one a fine carpet", () => {
    const size = (count: number) => layoutField(plantings(count), 900, 500).scale;
    expect(size(4)).toBeGreaterThan(size(200));
  });

  test("staggers the sprout so the field grows in rather than appearing at once", () => {
    const delays = layoutField(plantings(12), 900, 500).stalks.map((stalk) => stalk.sproutDelay);
    expect(new Set(delays).size).toBeGreaterThan(1);
    expect(Math.min(...delays)).toBeGreaterThanOrEqual(0);
  });

  test("deepens the planted band with the row count instead of holding a fixed horizon", () => {
    const band = (count: number) => {
      const field = layoutField(plantings(count), 900, 700);
      return field.frontY - field.horizonY;
    };
    expect(band(2)).toBeLessThan(band(60));
    // A field wants sky above it, so the band never eats the whole frame.
    expect(band(500)).toBeLessThanOrEqual(700 * 0.62);
  });

  test("holds every row inside the band, so no tulip is rooted above the horizon", () => {
    const field = layoutField(plantings(40), 900, 500);
    for (const stalk of field.stalks) {
      expect(stalk.y).toBeGreaterThanOrEqual(field.horizonY - 0.001);
      expect(stalk.y).toBeLessThanOrEqual(field.frontY + 0.001);
    }
  });
});

describe("indexSeed", () => {
  test("does not run in blocks the way a string hash of a counter does", () => {
    const kept = Array.from({ length: 200 }, (_, i) => indexSeed(i, 4) >= 0.4);
    let longest = 0;
    let run = 0;
    for (let i = 1; i < kept.length; i++) {
      run = kept[i] === kept[i - 1] ? run + 1 : 0;
      longest = Math.max(longest, run);
    }
    // A correlated hash gave runs of twenty, which read as a comb rather than as a treeline.
    expect(longest).toBeLessThan(14);
  });

  test("stays in range and spreads evenly", () => {
    const values = Array.from({ length: 2000 }, (_, i) => indexSeed(i, 1));
    expect(Math.min(...values)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...values)).toBeLessThanOrEqual(1);
    const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
    expect(mean).toBeGreaterThan(0.45);
    expect(mean).toBeLessThan(0.55);
  });
});

describe("barnRows", () => {
  test("paints the business name on the barn", () => {
    expect(barnRows("Maddhruv Blooms").join("\n")).toContain("MADDHRUV BLOOMS");
  });

  test("leaves the board blank rather than inventing a name", () => {
    const rows = barnRows("   ");
    // Only the braced doors are lettered; there is no name to paint on the board.
    const lettering = rows.join("").replace(/[^A-Z]/g, "");
    expect(lettering).toBe("X".repeat(lettering.length));
    // Still a barn: an unnamed instance loses the sign, not the building.
    expect(rows.length).toBeGreaterThan(4);
  });

  test("sets every row to one width, or the monospace walls do not line up", () => {
    for (const name of ["", "Acme", "A Very Long Business Name Indeed"]) {
      const widths = new Set(barnRows(name).map((row) => row.length));
      expect(widths.size).toBe(1);
    }
  });

  test("grows the barn to fit the name and then stops", () => {
    const short = barnRows("Acme")[0]?.length ?? 0;
    const long = barnRows("Maddhruv Blooms")[0]?.length ?? 0;
    expect(long).toBeGreaterThan(short);
    // Capped, so one absurd name cannot run the barn off the frame.
    expect(barnRows("A".repeat(200))[0]?.length).toBe(barnRows("A".repeat(16))[0]?.length);
  });
});
