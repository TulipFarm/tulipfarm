import { render, screen, waitFor } from "@testing-library/react";
import { createSurfaceArtifact } from "@tulipfarm/surface";
import { afterEach, describe, expect, it, vi } from "vitest";
import { apiGet } from "~/lib/api";
import { SurfaceArtifact } from "./surface-artifact";

vi.mock("~/lib/api", () => ({ apiGet: vi.fn() }));

describe("SurfaceArtifact", () => {
  afterEach(() => {
    vi.mocked(apiGet).mockReset();
  });

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

  it("requests the exact live revision instead of the latest Artifact", async () => {
    vi.mocked(apiGet).mockResolvedValue({
      artifact: {
        ...createSurfaceArtifact({
          id: "status",
          component: { name: "Status", version: "1.0" },
          props: { label: "Done" },
          target: { channel: "web", surface: "chat" },
          audience: ["user:1"],
          classification: "internal",
        }),
        revision: 2,
      },
      actionHandles: {},
    });

    render(<SurfaceArtifact artifactId="status" revision={2} />);

    await waitFor(() => expect(apiGet).toHaveBeenCalledWith("/api/v1/surfaces/status?revision=2"));
  });
});
