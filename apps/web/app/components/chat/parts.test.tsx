import { createRemixStub } from "@remix-run/testing";
import { render, screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import type { TimelinePart } from "~/lib/chat/types";
import { MessagePartView } from "./parts";

test("an a2ui part renders the sandboxed A2uiFrame iframe", () => {
  const part: TimelinePart = { kind: "a2ui", html: "<tf-card>x</tf-card>" };
  const { container } = render(
    <MessagePartView part={part} onApprove={() => {}} onA2uiAgent={vi.fn()} />
  );
  const iframe = container.querySelector('iframe[title="A2UI content"]');
  expect(iframe).not.toBeNull();
  expect(iframe?.getAttribute("sandbox")).toBe("allow-scripts");
});

test("a sources part links concept citations in-app and renders muted unlinked sources", () => {
  const part: TimelinePart = {
    kind: "sources",
    sources: [
      { id: "d", title: "Refund Policy", url: "/knowledge/concepts/d" },
      { title: "External Doc", url: "https://example.com/x" },
      { title: "No Link" },
    ],
  };
  const Stub = createRemixStub([
    {
      path: "/",
      Component: () => <MessagePartView part={part} onApprove={() => {}} onA2uiAgent={vi.fn()} />,
    },
  ]);
  render(<Stub initialEntries={["/"]} />);

  // Internal concept link → in-app anchor (no target=_blank), with the 📖 glyph.
  const internal = screen.getByRole("link", { name: /Refund Policy/ });
  expect(internal).toHaveAttribute("href", "/knowledge/concepts/d");
  expect(internal).not.toHaveAttribute("target", "_blank");
  expect(screen.getByText(/Refund Policy/).textContent).toContain("📖");

  // External link → new tab.
  const external = screen.getByRole("link", { name: /External Doc/ });
  expect(external).toHaveAttribute("href", "https://example.com/x");
  expect(external).toHaveAttribute("target", "_blank");

  // Unlinked source → muted text, not a link.
  expect(screen.queryByRole("link", { name: /No Link/ })).toBeNull();
  expect(screen.getByText(/No Link/)).toBeInTheDocument();
});
