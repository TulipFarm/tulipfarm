import { createRemixStub } from "@remix-run/testing";
import { render, screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { getGuardrails } from "~/lib/admin";
import BusinessGuardrails, { clientLoader } from "./_app.business.guardrails";

vi.mock("~/lib/admin", () => ({
  getGuardrails: vi.fn(),
  proposeGuardrailToggle: vi.fn(),
}));

function renderPage() {
  const Stub = createRemixStub([
    { path: "/business/guardrails", Component: BusinessGuardrails, loader: clientLoader },
    { path: "/", Component: () => <p>chat</p> },
  ]);
  return render(<Stub initialEntries={["/business/guardrails"]} />);
}

test("offers a create path even when no guardrail is configured yet", async () => {
  vi.mocked(getGuardrails).mockResolvedValue({ revision: "abc1234def", items: [] });

  renderPage();

  expect(await screen.findByText("No guardrails configured.")).toBeInTheDocument();
  const add = screen.getByRole("link", { name: "Add guardrail" });
  // The composer is the authoring surface; the page never posts a policy of its own.
  expect(add).toHaveAttribute("href", expect.stringContaining("/?draft="));
  expect(decodeURIComponent(add.getAttribute("href") ?? "")).toContain("Add a guardrail.");
});

test("keeps the create path available beside configured guardrails", async () => {
  vi.mocked(getGuardrails).mockResolvedValue({
    revision: "abc1234def",
    items: [{ id: "tool-call", name: "tool-call" }],
  });

  renderPage();

  expect(await screen.findByText("tool-call")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Add guardrail" })).toBeInTheDocument();
});
