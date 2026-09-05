import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The sandbox frame executes agent-authored code. `allow-same-origin` next to `allow-scripts`
 * removes the opaque origin, which is the only thing keeping that code away from the session
 * cookie and the host DOM. It is easy to add while chasing an unrelated frame bug, so it is pinned
 * here rather than left to review.
 */
const ROOT = join(import.meta.dirname, "..", "..", "..");
const SEARCHED = [
  join(ROOT, "apps", "web", "app"),
  join(ROOT, "apps", "web", "surface-sandbox"),
  join(ROOT, "packages", "surface-web", "src"),
  join(ROOT, "packages", "surface", "src"),
];

function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      found.push(...sourceFiles(path));
    } else if (/\.(ts|tsx|html)$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
      found.push(path);
    }
  }
  return found;
}

describe("Surface sandbox", () => {
  it("never grants the code-view frame a same origin", () => {
    const offenders = SEARCHED.flatMap(sourceFiles).filter((path) =>
      // Backticked mentions are prose explaining why the grant is absent; anything else is a
      // literal heading for an attribute.
      /(?<!`)allow-same-origin(?!`)/.test(readFileSync(path, "utf8"))
    );

    expect(offenders).toEqual([]);
  });
});
