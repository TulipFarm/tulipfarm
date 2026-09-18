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

test("shows effective defaults and keeps the create path available", async () => {
  vi.mocked(getGuardrails).mockResolvedValue({
    revision: "abc1234def",
    source: "default",
    items: [
      {
        id: "output:0:content_filter",
        name: "content_filter",
        scope: "output",
        source: "default",
        policy: {
          guard: "content_filter",
          patterns: ["credit_card", "ssn", "api_key", "email"],
        },
      },
    ],
  });

  renderPage();

  expect(await screen.findByText(/Built-in defaults are active/)).toBeInTheDocument();
  expect(screen.getByText("Email addresses")).toBeInTheDocument();
  expect(screen.getByText("Built-in")).toBeInTheDocument();
  const add = screen.getByRole("link", { name: "Add guardrail" });
  // The composer is the authoring surface; the page never posts a policy of its own.
  expect(add).toHaveAttribute("href", expect.stringContaining("/?draft="));
  expect(decodeURIComponent(add.getAttribute("href") ?? "")).toContain("Add a guardrail.");
});

test("keeps the create path available beside configured guardrails", async () => {
  vi.mocked(getGuardrails).mockResolvedValue({
    revision: "abc1234def",
    source: "custom",
    items: [
      {
        id: "tool-call:0:tool_blocklist",
        name: "tool_blocklist",
        scope: "tool-call",
        source: "custom",
        policy: { guard: "tool_blocklist", block: ["run_command"] },
      },
    ],
  });

  renderPage();

  expect(await screen.findByText("tool_blocklist")).toBeInTheDocument();
  expect(screen.getByText(/Custom Soul policy is active/)).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Add guardrail" })).toBeInTheDocument();
});

test("explains hosted minimums without offering a weakening control", async () => {
  vi.mocked(getGuardrails).mockResolvedValue({
    revision: "hosted123",
    source: "custom",
    platformConstrained: true,
    items: [
      {
        id: "tool-call:0:tool_blocklist",
        name: "tool_blocklist",
        scope: "tool-call",
        source: "custom",
        policy: { guard: "tool_blocklist", block: ["run_command", "record_delete"] },
      },
    ],
  });
  renderPage();
  expect(
    await screen.findByText(/Platform minimums and business restrictions/)
  ).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Turn off" })).not.toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Add guardrail" })).toBeInTheDocument();
});
