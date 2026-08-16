import { describe, expect, test } from "vitest";
import { barnRows } from "~/components/farm/field-scenery";

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
