import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * SPA mode permits `HydrateFallback` on the root route only. Exporting one from any other route is
 * a *build*-time error, which means neither `typecheck` nor the jsdom suite can see it — the first
 * signal is a failed production build, long after the change looks green.
 *
 * Two Knowledge routes shipped exactly that mistake. This test is the cheap standing guard, so the
 * next one costs a second rather than a build.
 */
const routesDir = resolve(__dirname, "../routes");

describe("SPA-mode route exports", () => {
  it("declares HydrateFallback on the root route and nowhere else", () => {
    const offenders = readdirSync(routesDir)
      .filter((f) => f.endsWith(".tsx"))
      .filter((f) =>
        /export function HydrateFallback|export const HydrateFallback/.test(
          readFileSync(resolve(routesDir, f), "utf8")
        )
      );

    expect(offenders).toEqual([]);
    expect(readFileSync(resolve(__dirname, "../root.tsx"), "utf8")).toContain(
      "export function HydrateFallback"
    );
  });
});
