import { createRemixStub } from "@remix-run/testing";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BookOpen, Inbox, MessageSquare } from "lucide-react";
import { beforeEach, expect, test, vi } from "vitest";
import {
  AppShell,
  AppSidebar,
  iconForPath,
  modeForPath,
  titleForPath,
} from "~/components/app-sidebar";
import * as approvalsContext from "~/lib/approvals-context";
import * as conversationsContext from "~/lib/conversations-context";

vi.mock("~/lib/approvals-context", () => ({ useApprovals: vi.fn() }));
const useApprovals = vi.mocked(approvalsContext.useApprovals);

vi.mock("~/lib/conversations-context", () => ({ useConversations: vi.fn() }));
const useConversations = vi.mocked(conversationsContext.useConversations);

const SidebarStub = createRemixStub([{ path: "*", Component: AppSidebar }]);
const RestrictedSidebarStub = createRemixStub([
  {
    path: "*",
    Component: () => (
      <AppSidebar navigation={{ visiblePaths: ["/resources", "/business/activities"] }} />
    ),
  },
]);
const ShellStub = createRemixStub([
  {
    path: "*",
    Component: () => (
      <AppShell>
        <p>Page content</p>
      </AppShell>
    ),
  },
]);
const AccountShellStub = createRemixStub([
  {
    path: "*",
    Component: () => (
      <AppShell
        user={{
          id: "u1",
          email: "priya.nair@northgate.dev",
          name: null,
          role: "admin",
          status: "active",
          navigation: { visiblePaths: [] },
        }}
      >
        <p>Page content</p>
      </AppShell>
    ),
  },
]);

const CONVERSATIONS = {
  conversations: [],
  loading: false,
  error: null,
  refresh: vi.fn(),
  activeChatId: null,
  setActiveChatId: vi.fn(),
  activeChatTitle: null,
  setActiveChatTitle: vi.fn(),
  newChatNonce: 0,
  startNewChat: vi.fn(),
  renameChat: vi.fn(),
  removeChat: vi.fn(),
};

beforeEach(() => {
  localStorage.clear();
  useApprovals.mockReturnValue({
    approvals: [],
    count: 0,
    loading: false,
    error: null,
    refresh: vi.fn(),
  });
  useConversations.mockReturnValue(CONVERSATIONS);
});

test("maps deep routes to stable product modes and top-bar titles", () => {
  expect(modeForPath("/chat/c1")).toBe("chat");
  expect(modeForPath("/skills/forecasting")).toBe("build");
  expect(modeForPath("/knowledge/spaces/ops")).toBe("knowledge");
  expect(modeForPath("/runs/run-1")).toBe("operate");
  expect(modeForPath("/settings/instructions")).toBe("settings");
  expect(modeForPath("/design-guide")).toBe("settings");
  expect(titleForPath("/resources/tickets")).toBe("Resources");
  expect(titleForPath("/operations")).toBe("Operations");
});

test("gives every page its own top-bar icon instead of the Chat glyph", () => {
  expect(iconForPath("/inbox")).toBe(Inbox);
  expect(iconForPath("/knowledge/spaces/ops")).toBe(BookOpen);
  expect(iconForPath("/chat/c1")).toBe(MessageSquare);
});

test("names the context panel after the current mode, not the Chat glyph", () => {
  render(<SidebarStub initialEntries={["/inbox"]} />);
  expect(screen.getByRole("heading", { level: 2, name: "Operate" })).toBeInTheDocument();
});

test("drops the placeholder overflow menus from the sidebar and top bar", () => {
  render(<ShellStub initialEntries={["/inbox"]} />);
  expect(screen.getAllByRole("main")).toHaveLength(1);
  expect(screen.getByRole("main")).toHaveAttribute("id", "main-content");
  expect(screen.queryByRole("button", { name: "Chat options" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Page options" })).not.toBeInTheDocument();
});

test("renders the global product-mode rail and Chat context", () => {
  render(<SidebarStub initialEntries={["/"]} />);
  const rail = screen.getByRole("navigation", { name: "Product modes" });
  for (const label of ["Chat", "Build", "Knowledge", "Operate"]) {
    expect(within(rail).getByRole("link", { name: label })).toBeInTheDocument();
  }
  expect(within(rail).getByRole("link", { name: "Chat" })).toHaveAttribute("aria-current", "page");
  expect(screen.getByRole("button", { name: "New chat" })).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Recent chats" })).toHaveAttribute("href", "/chats");
});

test("keeps Farm out of the working modes, beside the other utilities", () => {
  render(<SidebarStub initialEntries={["/"]} />);
  const rail = screen.getByRole("navigation", { name: "Product modes" });
  const working = ["Chat", "Build", "Knowledge", "Operate"];

  expect(
    within(rail)
      .getAllByRole("link")
      .map((link) => link.getAttribute("aria-label"))
  ).toEqual(working);

  const order = screen
    .getAllByRole("link")
    .map((link) => link.getAttribute("aria-label"))
    .filter((label) => label && [...working, "Farm", "Settings"].includes(label));
  expect(order).toEqual([...working, "Farm", "Settings"]);
});

test("gives Farm the whole surface, with no context panel to repeat the page", () => {
  render(<ShellStub initialEntries={["/farm"]} />);

  expect(screen.queryByRole("navigation", { name: "Farm" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /context sidebar/ })).not.toBeInTheDocument();
  expect(screen.getByRole("navigation", { name: "Product modes" })).toBeInTheDocument();
});

test("keeps the Farm rail off-canvas on mobile instead of pinning it over the field", () => {
  render(<ShellStub initialEntries={["/farm"]} />);

  const aside = screen.getByRole("complementary", { name: "Application navigation" });
  // Without the off-canvas transform the fixed rail sits on top of the page at phone widths.
  expect(aside.className).toContain("-translate-x-full");
  expect(aside.className).toContain("md:translate-x-0");
});

test("renders Build destinations in the contextual sidebar", () => {
  render(<SidebarStub initialEntries={["/resources"]} />);
  expect(screen.getByRole("link", { name: "Build" })).toHaveAttribute("aria-current", "page");
  for (const label of ["Resources", "Agents", "Skills", "Routines"]) {
    expect(screen.getByRole("link", { name: label })).toBeInTheDocument();
  }
  expect(screen.queryByRole("link", { name: "Inbox" })).not.toBeInTheDocument();
});

test("renders Operate destinations and the live Inbox badge", () => {
  useApprovals.mockReturnValue({
    approvals: [],
    count: 2,
    loading: false,
    error: null,
    refresh: vi.fn(),
  });
  render(<SidebarStub initialEntries={["/inbox"]} />);
  const inbox = screen.getByRole("link", { name: /inbox/i });
  expect(within(inbox).getByText("2")).toBeInTheDocument();
  for (const label of ["Inbox", "Activity", "Integrations", "Operations"]) {
    expect(screen.getByRole("link", { name: new RegExp(label, "i") })).toBeInTheDocument();
  }
});

test("hides denied destinations and sends Operate to the first allowed page", () => {
  render(<RestrictedSidebarStub initialEntries={["/business/activities"]} />);

  const rail = screen.getByRole("navigation", { name: "Product modes" });
  expect(within(rail).getByRole("link", { name: "Operate" })).toHaveAttribute(
    "href",
    "/business/activities"
  );
  expect(screen.getByRole("link", { name: "Activity" })).toBeInTheDocument();
  for (const label of ["Inbox", "Operations", "Soul", "Models"]) {
    expect(screen.queryByRole("link", { name: new RegExp(label, "i") })).not.toBeInTheDocument();
  }
  expect(within(rail).queryByRole("link", { name: "Knowledge" })).not.toBeInTheDocument();
});

test("renders only personal destinations under Settings", () => {
  render(<SidebarStub initialEntries={["/settings/profile"]} />);
  for (const label of ["Profile", "Appearance", "Auth", "Custom instructions"]) {
    expect(screen.getByRole("link", { name: label })).toBeInTheDocument();
  }
  // Workspace configuration is Operate's job now, so none of it may appear here.
  for (const label of ["Secrets", "Models", "Observability", "People", "Business profile"]) {
    expect(screen.queryByRole("link", { name: label })).not.toBeInTheDocument();
  }
  expect(screen.getByRole("link", { name: "Design guide" })).toHaveAttribute(
    "href",
    "/design-guide"
  );
});

test("groups business configuration under Operate", () => {
  render(<SidebarStub initialEntries={["/business/models"]} />);
  for (const label of ["Business profile", "Models", "Secrets", "Soul", "Guardrails", "About"]) {
    expect(screen.getByRole("link", { name: label })).toBeInTheDocument();
  }
  expect(screen.getByRole("link", { name: "Models" })).toHaveAttribute("href", "/business/models");
});

test("renders recent chats and highlights the active Chat", () => {
  useConversations.mockReturnValue({
    ...CONVERSATIONS,
    conversations: [
      {
        id: "c1",
        title: "Inventory planning",
        agentId: null,
        starred: false,
        createdAt: "t",
        updatedAt: "t",
      },
      { id: "c2", title: null, agentId: null, starred: false, createdAt: "t", updatedAt: "t" },
    ],
    activeChatId: "c1",
    activeChatTitle: "Inventory planning",
  });
  render(<SidebarStub initialEntries={["/"]} />);
  expect(screen.getByRole("link", { name: "Inventory planning" })).toHaveAttribute(
    "aria-current",
    "page"
  );
  expect(screen.getByRole("link", { name: "New chat" })).toHaveAttribute("href", "/chat/c2");
});

test("starts a fresh Chat from the contextual sidebar", async () => {
  const user = userEvent.setup();
  const startNewChat = vi.fn();
  useConversations.mockReturnValue({ ...CONVERSATIONS, startNewChat });
  render(<SidebarStub initialEntries={["/"]} />);
  await user.click(screen.getByRole("button", { name: "New chat" }));
  expect(startNewChat).toHaveBeenCalledTimes(1);
});

test("renames a recent chat from the sidebar without following its link", async () => {
  const user = userEvent.setup();
  const renameChat = vi.fn(async () => CONVERSATIONS.conversations[0]);
  useConversations.mockReturnValue({
    ...CONVERSATIONS,
    conversations: [
      {
        id: "c1",
        title: "Inventory planning",
        agentId: null,
        starred: false,
        createdAt: "t",
        updatedAt: "t",
      },
    ],
    renameChat,
  });
  render(<SidebarStub initialEntries={["/"]} />);
  await user.click(screen.getByRole("button", { name: "Chat actions" }));
  await user.click(await screen.findByRole("menuitem", { name: /rename/i }));

  const input = screen.getByLabelText("Rename chat");
  await user.clear(input);
  await user.type(input, "Q3 restock{Enter}");
  expect(renameChat).toHaveBeenCalledWith("c1", "Q3 restock");
});

test("deletes a recent chat from the sidebar only after confirmation", async () => {
  const user = userEvent.setup();
  const removeChat = vi.fn(async () => {});
  useConversations.mockReturnValue({
    ...CONVERSATIONS,
    conversations: [
      {
        id: "c1",
        title: "Inventory planning",
        agentId: null,
        starred: false,
        createdAt: "t",
        updatedAt: "t",
      },
    ],
    removeChat,
  });
  render(<SidebarStub initialEntries={["/"]} />);
  await user.click(screen.getByRole("button", { name: "Chat actions" }));
  await user.click(await screen.findByRole("menuitem", { name: /delete/i }));
  expect(removeChat).not.toHaveBeenCalled();

  await user.click(screen.getByRole("button", { name: /^delete$/i }));
  expect(removeChat).toHaveBeenCalledWith("c1");
});

test("renders the shared top bar and restores focus after Escape closes navigation", async () => {
  const user = userEvent.setup();
  render(<ShellStub initialEntries={["/resources"]} />);
  expect(screen.getAllByText("Resources")).toHaveLength(2);
  expect(screen.getByText("Page content")).toBeInTheDocument();
  expect(screen.queryByText("Standard")).not.toBeInTheDocument();
  expect(screen.queryByText("TulipFarm")).not.toBeInTheDocument();

  const opener = screen.getByRole("button", { name: "Open navigation" });
  await user.click(opener);
  expect(opener).toHaveAttribute("aria-expanded", "true");
  await user.keyboard("{Escape}");
  expect(opener).toHaveAttribute("aria-expanded", "false");
  expect(opener).toHaveFocus();
});

test("trails the top-bar page behind a link back to its product mode", () => {
  render(<ShellStub initialEntries={["/runs/run-1"]} />);
  const breadcrumb = screen.getByRole("navigation", { name: "Breadcrumb" });
  expect(within(breadcrumb).getByRole("link", { name: "Operate" })).toHaveAttribute(
    "href",
    "/inbox"
  );
  expect(within(breadcrumb).getByText("Runs")).toHaveAttribute("aria-current", "page");
});

test("omits the parent crumb when it would only repeat the page", () => {
  render(<ShellStub initialEntries={["/knowledge/spaces/ops"]} />);
  const breadcrumb = screen.getByRole("navigation", { name: "Breadcrumb" });
  expect(within(breadcrumb).queryByRole("link")).not.toBeInTheDocument();
  expect(within(breadcrumb).getByText("Knowledge")).toHaveAttribute("aria-current", "page");
});

test("names the chat itself in the top bar, with no self-referential parent crumb", () => {
  useConversations.mockReturnValue({
    ...CONVERSATIONS,
    activeChatId: "c1",
    activeChatTitle: "Q3 pricing review",
  });
  render(<ShellStub initialEntries={["/chat/c1"]} />);
  const breadcrumb = screen.getByRole("navigation", { name: "Breadcrumb" });
  expect(within(breadcrumb).queryByRole("link")).not.toBeInTheDocument();
  expect(within(breadcrumb).getByText("Q3 pricing review")).toHaveAttribute("aria-current", "page");
});

test("renames the open chat by clicking its name in the top bar", async () => {
  const user = userEvent.setup();
  const renameChat = vi.fn(async () => CONVERSATIONS.conversations[0]);
  useConversations.mockReturnValue({
    ...CONVERSATIONS,
    activeChatId: "c1",
    activeChatTitle: "Q3 pricing review",
    renameChat,
  });
  render(<ShellStub initialEntries={["/chat/c1"]} />);
  await user.click(screen.getByRole("button", { name: "Rename this chat: Q3 pricing review" }));

  const input = screen.getByLabelText("Rename this chat");
  expect(input).toHaveAttribute("maxlength", "200");
  await user.clear(input);
  await user.type(input, "Q3 pricing, final{Enter}");
  expect(renameChat).toHaveBeenCalledWith("c1", "Q3 pricing, final");
});

test("deletes the open chat from the top bar only after confirmation", async () => {
  const user = userEvent.setup();
  const removeChat = vi.fn(async () => {});
  useConversations.mockReturnValue({
    ...CONVERSATIONS,
    activeChatId: "c1",
    activeChatTitle: "Q3 pricing review",
    removeChat,
  });
  render(<ShellStub initialEntries={["/chat/c1"]} />);
  await user.click(screen.getByRole("button", { name: "Chat actions" }));
  await user.click(await screen.findByRole("menuitem", { name: /delete/i }));
  expect(removeChat).not.toHaveBeenCalled();

  await user.click(screen.getByRole("button", { name: /^delete$/i }));
  expect(removeChat).toHaveBeenCalledWith("c1");
});

test("offers no rename or delete on the new-chat surface, which has nothing to act on", () => {
  render(<ShellStub initialEntries={["/"]} />);
  expect(screen.queryByRole("button", { name: "Chat actions" })).not.toBeInTheDocument();
});

test("keeps the chat actions reachable on touch, where there is no hover to reveal them", () => {
  useConversations.mockReturnValue({
    ...CONVERSATIONS,
    activeChatId: "c1",
    activeChatTitle: "Q3 pricing review",
  });
  render(<ShellStub initialEntries={["/chat/c1"]} />);
  const trigger = screen.getByRole("button", { name: "Chat actions" });
  // Hidden only from `sm` up: below it the trigger stays visible at a 44px target.
  expect(trigger.className).toContain("sm:opacity-0");
  expect(trigger.className).not.toMatch(/(^|\s)opacity-0(\s|$)/);
  expect(trigger.className).toContain("size-11");
});

test("keeps a refused delete inside its dialog, where the backdrop cannot hide it", async () => {
  const user = userEvent.setup();
  const removeChat = vi.fn(async () => {
    throw new Error("This chat has a Turn in progress.");
  });
  useConversations.mockReturnValue({
    ...CONVERSATIONS,
    activeChatId: "c1",
    activeChatTitle: "Q3 pricing review",
    removeChat,
  });
  render(<ShellStub initialEntries={["/chat/c1"]} />);
  await user.click(screen.getByRole("button", { name: "Chat actions" }));
  await user.click(await screen.findByRole("menuitem", { name: /delete/i }));
  await user.click(screen.getByRole("button", { name: /^delete$/i }));

  const dialog = await screen.findByRole("dialog");
  expect(within(dialog).getByRole("alert")).toHaveTextContent("This chat has a Turn in progress.");
  // The dialog stays open so the user can read the reason and retry or cancel.
  expect(within(dialog).getByRole("button", { name: /^delete$/i })).toBeEnabled();
});

test("does not seed the rename field with the placeholder shown before the titler lands", async () => {
  const user = userEvent.setup();
  useConversations.mockReturnValue({ ...CONVERSATIONS, activeChatId: "c1", activeChatTitle: null });
  render(<ShellStub initialEntries={["/chat/c1"]} />);
  await user.click(screen.getByRole("button", { name: "Rename this chat: New chat" }));
  expect(screen.getByLabelText("Rename this chat")).toHaveValue("");
});

test("calls an untitled chat surface a new chat", () => {
  render(<ShellStub initialEntries={["/"]} />);
  const breadcrumb = screen.getByRole("navigation", { name: "Breadcrumb" });
  expect(within(breadcrumb).queryByRole("link")).not.toBeInTheDocument();
  expect(within(breadcrumb).getByText("New chat")).toBeInTheDocument();
});

test("reduces the signed-in account to a monogram in the top bar", () => {
  render(<AccountShellStub initialEntries={["/inbox"]} />);
  const account = screen.getByRole("link", {
    name: "Account settings for priya.nair@northgate.dev",
  });
  expect(account).toHaveAttribute("href", "/settings/profile");
  expect(account).toHaveTextContent("PN");
  expect(screen.queryByText("priya.nair@northgate.dev")).not.toBeInTheDocument();
});

test("renders the report a bug button in the top bar", () => {
  render(<ShellStub initialEntries={["/inbox"]} />);
  expect(screen.getByRole("button", { name: "Report a bug" })).toBeInTheDocument();
});
