import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ConnectionStatus, DestructivePreview, PermissionDeniedState } from "./states";

describe("shell state primitives", () => {
  it("announces reconnect state without exposing transport details", () => {
    render(<ConnectionStatus state="reconnecting" attempt={2} />);
    expect(screen.getByRole("status")).toHaveTextContent("Reconnecting");
    expect(screen.getByRole("status")).not.toHaveTextContent("token");
  });

  it("presents exact destructive target and requires server action confirmation", () => {
    const onConfirm = vi.fn();
    render(
      <DestructivePreview
        action="Cancel Run"
        target="run-1"
        destination="TulipFarm Run authority"
        reversibility="Cannot undo in-flight provider effects"
        onConfirm={onConfirm}
      />
    );
    expect(screen.getByText("run-1")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Confirm Cancel Run" })).toBeInTheDocument();
  });

  it("renders safe permission denial with correlation evidence", () => {
    render(<PermissionDeniedState correlationId="req-safe-1" />);
    expect(screen.getByText(/req-safe-1/)).toBeInTheDocument();
    expect(screen.queryByText(/stack/i)).not.toBeInTheDocument();
  });
});
