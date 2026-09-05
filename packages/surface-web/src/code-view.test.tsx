import type { SurfaceArtifact } from "@tulipfarm/surface/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SurfaceCodeView } from "./code-view";

// Built by hand rather than through `createSurfaceArtifact`, which validates the component against
// the shipped catalog — a code-backed component is by definition not in it.
const artifact: SurfaceArtifact = {
  protocol: "tsp",
  protocolVersion: "1.0",
  id: "code",
  revision: 1,
  component: { name: "business.area-chart", version: "1.0" },
  props: { series: [1, 2, 3] },
  target: { channel: "web", surface: "chat" },
  catalogRevision: "test",
  audience: ["user:1"],
  classification: "internal",
  lineage: [],
};

describe("SurfaceCodeView", () => {
  it("frames authored code with no same-origin grant", () => {
    const markup = renderToStaticMarkup(
      <SurfaceCodeView artifact={artifact} module="return null;" />
    );

    // The whole security boundary in one assertion: `allow-same-origin` would give authored code
    // the session cookie and the host DOM. Never widen this attribute.
    expect(markup).toContain('sandbox="allow-scripts"');
    expect(markup).not.toContain("allow-same-origin");
    expect(markup).toContain('src="/surface-sandbox/frame.html"');
  });

  it("never puts the authored module in the host document", () => {
    const markup = renderToStaticMarkup(
      <SurfaceCodeView artifact={artifact} module="window.__pwned = 1;" />
    );

    expect(markup).not.toContain("__pwned");
  });
});
