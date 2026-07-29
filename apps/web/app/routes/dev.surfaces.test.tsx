import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import DevelopmentSurfacesRoute from "./dev.surfaces";

describe("/dev/surfaces", () => {
  it("renders the protocol gallery", () => {
    render(<DevelopmentSurfacesRoute />);
    expect(screen.getByRole("heading", { name: "Tulip Surface Protocol" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Healthy");
  });
});
