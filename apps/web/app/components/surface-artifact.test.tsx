import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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

    await waitFor(() =>
      expect(apiGet).toHaveBeenCalledWith(
        "/api/v1/surfaces/status?revision=2",
        expect.objectContaining({ signal: expect.any(AbortSignal) })
      )
    );
  });

  it("replaces an older revision and ignores its late response", async () => {
    let resolveOld: ((value: unknown) => void) | undefined;
    vi.mocked(apiGet)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveOld = resolve;
          })
      )
      .mockResolvedValueOnce({
        artifact: {
          ...createSurfaceArtifact({
            id: "status",
            component: { name: "Status", version: "1.0" },
            props: { label: "Newest" },
            target: { channel: "web", surface: "chat" },
            audience: ["user:1"],
            classification: "internal",
          }),
          revision: 2,
        },
        actionHandles: {},
      });
    const { rerender } = render(<SurfaceArtifact artifactId="status" revision={1} />);
    rerender(<SurfaceArtifact artifactId="status" revision={2} />);

    expect(await screen.findByText("Newest")).toBeInTheDocument();
    resolveOld?.({
      artifact: {
        ...createSurfaceArtifact({
          id: "status",
          component: { name: "Status", version: "1.0" },
          props: { label: "Stale" },
          target: { channel: "web", surface: "chat" },
          audience: ["user:1"],
          classification: "internal",
        }),
        revision: 1,
      },
      actionHandles: {},
    });
    await Promise.resolve();
    expect(screen.queryByText("Stale")).not.toBeInTheDocument();
  });

  it("shows an accessible failure and retries on demand", async () => {
    const user = userEvent.setup();
    vi.mocked(apiGet)
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({
        artifact: {
          ...createSurfaceArtifact({
            id: "status",
            component: { name: "Status", version: "1.0" },
            props: { label: "Recovered" },
            target: { channel: "web", surface: "chat" },
            audience: ["user:1"],
            classification: "internal",
          }),
          revision: 3,
        },
        actionHandles: {},
      });

    render(<SurfaceArtifact artifactId="status" revision={3} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Presentation could not be loaded.");
    await user.click(screen.getByRole("button", { name: "Retry presentation" }));
    expect(await screen.findByText("Recovered")).toBeInTheDocument();
    expect(apiGet).toHaveBeenCalledTimes(2);
  });
});
