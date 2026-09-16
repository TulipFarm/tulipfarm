import { createRemixStub } from "@remix-run/testing";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { commandEntries, SidebarCommand } from "~/components/sidebar-command";
import * as conversationsContext from "~/lib/conversations-context";

vi.mock("~/lib/conversations-context", () => ({ useConversations: vi.fn() }));
const useConversations = vi.mocked(conversationsContext.useConversations);

// biome-ignore lint/suspicious/noExplicitAny: matches the hook's loosely-typed test double elsewhere in this app
useConversations.mockReturnValue({
  conversations: [],
  loading: false,
  error: null,
  refresh: vi.fn(),
  activeChatId: null,
  startNewChat: vi.fn(),
} as any);

const VISIBILITY = { isDev: false };

const Stub = createRemixStub([
  {
    path: "*",
    Component: () => (
      <>
        <button type="button">Onboarding companion</button>
        <SidebarCommand visibility={VISIBILITY} collapsed={false} />
      </>
    ),
  },
]);

test("finder exposes Packs and Import Pack only when the server permits the catalog", () => {
  const entries = (visiblePaths: string[]) =>
    commandEntries({ isDev: false, visiblePaths }, [], { startNewChat: vi.fn() });
  expect(entries(["/packs"])).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ label: "Packs", to: "/packs" }),
      expect.objectContaining({ label: "Import Pack", to: "/packs/import" }),
    ])
  );
  expect(entries([]).some((entry) => entry.to?.startsWith("/packs"))).toBe(false);
});

test("traps Tab focus inside the open command menu", async () => {
  const user = userEvent.setup();
  render(<Stub />);

  await user.click(screen.getByRole("button", { name: "Search pages, chats and actions" }));
  const dialog = await screen.findByRole("dialog", { name: "Command menu" });
  const input = screen.getByPlaceholderText("Search pages, chats and actions");
  expect(input).toHaveFocus();

  // Shift+Tab from the first focusable element must stay inside the dialog, not reach the
  // background "Onboarding companion" trigger.
  await user.tab({ shift: true });
  expect(dialog.contains(document.activeElement)).toBe(true);
  expect(screen.getByText("Onboarding companion")).not.toHaveFocus();

  // Tabbing forward from the last focusable element must wrap back to the first, not escape.
  await user.tab();
  await user.tab();
  expect(dialog.contains(document.activeElement)).toBe(true);
});
