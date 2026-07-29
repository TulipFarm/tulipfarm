import { render, screen } from "@testing-library/react";
import { createSurfaceArtifact } from "@tulipfarm/surface";
import { describe, expect, it } from "vitest";
import { SurfaceArtifact } from "./surface-artifact";

describe("SurfaceArtifact", () => {
  it("renders a semantic Artifact with trusted React", () => {
    render(
      <SurfaceArtifact
        artifactId="status"
        revision={1}
        artifact={createSurfaceArtifact({
          id: "status",
          component: { name: "Status", version: "1.0" },
          props: { label: "Ready" },
          target: { channel: "web", surface: "chat" },
          audience: ["user:1"],
          classification: "internal",
        })}
      />
    );
    expect(screen.getByRole("status")).toHaveTextContent("Ready");
  });
});
