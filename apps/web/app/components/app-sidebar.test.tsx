import { createRemixStub } from "@remix-run/testing";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BookOpen, Inbox, MessageSquare } from "lucide-react";
import { beforeEach, expect, test, vi } from "vitest";
import { AppShell, AppSidebar, iconForPath, titleForPath } from "~/components/app-sidebar";
import * as approvalsContext from "~/lib/approvals-context";
import * as conversationsContext from "~/lib/conversations-context";

vi.mock("~/lib/approvals-context", () => ({ useApprovals: vi.fn() }));
const useApprovals = vi.mocked(approvalsContext.useApprovals);

vi.mock("~/lib/conversations-context", () => ({ useConversations: vi.fn() }));
const useConversations = vi.mocked(conversationsContext.useConversations);

const USER = {
  id: "u1",
  email: "priya.nair@northgate.dev",
  name: null,
  role: "admin" as const,
  status: "active" as const,
  navigation: { visiblePaths: [] },
};

const SidebarStub = createRemixStub([{ path: "*", Component: AppSidebar }]);
const AccountSidebarStub = createRemixStub([
  { path: "*", Component: () => <AppSidebar user={USER} /> },
]);
const RestrictedSidebarStub = createRemixStub([
  {
    path: "*",
    Component: () => (
      <AppSidebar
        user={{ ...USER, navigation: { visiblePaths: ["/resources", "/business/activities"] } }}
      />
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
  delete document.documentElement.dataset.sidebar;
  useApprovals.mockReturnValue({
    approvals: [],
    count: 0,
    loading: false,
    error: null,
    refresh: vi.fn(),
  });
  useConversations.mockReturnValue(CONVERSATIONS);
});

test("maps deep routes to stable top-bar titles", () => {
  expect(titleForPath("/resources/tickets")).toBe("Resources");
  expect(titleForPath("/operations")).toBe("Operations");
  expect(titleForPath("/settings/instructions")).toBe("Custom instructions");
});

test("gives every page its own top-bar icon instead of the Chat glyph", () => {
  expect(iconForPath("/inbox")).toBe(Inbox);
  expect(iconForPath("/knowledge/spaces/ops")).toBe(BookOpen);
  expect(iconForPath("/chat/c1")).toBe(MessageSquare);
});

/*
 * The point of the redesign: one list, no rail, no second panel to open. If a rail or a mode
 * switcher comes back, a reader is once again two clicks from a destination they can already see.
 */
test("renders every destination in one flat list, with no rail or second panel", () => {
  render(<SidebarStub initialEntries={["/inbox"]} />);
  const nav = screen.getByRole("navigation", { name: "Main" });

  for (const heading of ["Work", "Build"]) {
    expect(within(nav).getByRole("heading", { level: 2, name: heading })).toBeInTheDocument();
  }
  for (const label of ["Chats", "Inbox", "Activity", "Resources", "Agents", "Knowledge", "Farm"]) {
    expect(within(nav).getByRole("link", { name: new RegExp(label, "i") })).toBeInTheDocument();
  }

  expect(screen.queryByRole("navigation", { name: "Product modes" })).not.toBeInTheDocument();
  expect(within(nav).queryByRole("heading", { name: "Knowledge" })).not.toBeInTheDocument();
});

test("marks the destination matching the current page, and only that one", () => {
  render(<SidebarStub initialEntries={["/agents"]} />);
  const nav = screen.getByRole("navigation", { name: "Main" });

  expect(
    within(nav)
      .getAllByRole("link")
      .filter((link) => link.getAttribute("aria-current") === "page")
      .map((link) => link.textContent)
  ).toEqual(["Agents"]);
});

test("carries the live approval count on Inbox", () => {
  useApprovals.mockReturnValue({
    approvals: [],
    count: 2,
    loading: false,
    error: null,
    refresh: vi.fn(),
  });
  render(<SidebarStub initialEntries={["/inbox"]} />);

  expect(within(screen.getByRole("link", { name: /inbox/i })).getByText("2")).toBeInTheDocument();
});

/* Collapsed, the count shrinks to a dot — so the row's own label has to carry the number. */
test("still announces the approval count when the sidebar is collapsed", async () => {
  const user = userEvent.setup();
  useApprovals.mockReturnValue({
    approvals: [],
    count: 2,
    loading: false,
    error: null,
    refresh: vi.fn(),
  });
  render(<ShellStub initialEntries={["/inbox"]} />);

  await user.click(screen.getByRole("button", { name: "Collapse sidebar" }));
  expect(screen.getByRole("link", { name: "Inbox, 2 awaiting you" })).toBeInTheDocument();
});

test("hides denied destinations and the groups they empty", () => {
  render(<RestrictedSidebarStub initialEntries={["/business/activities"]} />);
  const nav = screen.getByRole("navigation", { name: "Main" });

  expect(within(nav).getByRole("link", { name: "Activity" })).toBeInTheDocument();
  expect(within(nav).getByRole("link", { name: "Resources" })).toBeInTheDocument();
  for (const label of ["Inbox", "Farm", "Knowledge"]) {
    expect(within(nav).queryByRole("link", { name: label })).not.toBeInTheDocument();
  }
  expect(within(nav).queryByRole("heading", { name: "Build" })).toBeInTheDocument();
  expect(screen.queryByRole("link", { name: "Settings" })).not.toBeInTheDocument();
});

/* Business configuration moved behind Settings, so the sidebar must not grow it back. */
test("keeps business configuration out of the sidebar", () => {
  render(<SidebarStub initialEntries={["/business/models"]} />);
  const nav = screen.getByRole("navigation", { name: "Main" });

  for (const label of ["Models", "Secrets", "Soul", "Guardrails", "Business profile", "Profile"]) {
    expect(within(nav).queryByRole("link", { name: label })).not.toBeInTheDocument();
  }
  expect(within(nav).queryByRole("link", { name: "Settings" })).not.toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Settings" })).toHaveAttribute("href", "/settings");
});

/* Operator surfaces followed business configuration behind the Settings door. */
test("keeps Operations and Observability out of the sidebar", () => {
  render(<SidebarStub initialEntries={["/operations"]} />);

  for (const label of ["Operations", "Observability"]) {
    expect(screen.queryByRole("link", { name: label })).not.toBeInTheDocument();
  }
});

test("renders recent chats and highlights the active one", () => {
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
  render(<SidebarStub initialEntries={["/chat/c1"]} />);

  expect(screen.getByRole("link", { name: "Inventory planning" })).toHaveAttribute(
    "aria-current",
    "page"
  );
  expect(screen.getByRole("link", { name: "New chat" })).toHaveAttribute("href", "/chat/c2");
  expect(screen.getByRole("link", { name: "Recent" })).toHaveAttribute("href", "/chats");
});

test("starts a fresh Chat from the sidebar", async () => {
  const user = userEvent.setup();
  const startNewChat = vi.fn();
  useConversations.mockReturnValue({ ...CONVERSATIONS, startNewChat });
  render(<SidebarStub initialEntries={["/inbox"]} />);

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

/* Sign-out and the theme lost their rail, so the account menu is now the only way to reach them. */
test("names the signed-in account and keeps sign-out reachable from its menu", async () => {
  const user = userEvent.setup();
  render(<AccountSidebarStub initialEntries={["/inbox"]} />);

  expect(screen.getByText("priya.nair@northgate.dev")).toBeInTheDocument();
  const trigger = screen.getByRole("button", {
    name: "Account menu for priya.nair@northgate.dev",
  });
  expect(trigger).toHaveTextContent("PN");
  expect(screen.queryByRole("button", { name: "Sign out" })).not.toBeInTheDocument();

  await user.click(trigger);
  expect(trigger).toHaveAttribute("aria-expanded", "true");
  expect(screen.getByRole("button", { name: "Sign out" })).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Profile" })).toHaveAttribute(
    "href",
    "/settings/profile"
  );
});

test("closes the account menu on Escape and returns focus to its trigger", async () => {
  const user = userEvent.setup();
  render(<AccountSidebarStub initialEntries={["/inbox"]} />);
  const trigger = screen.getByRole("button", {
    name: "Account menu for priya.nair@northgate.dev",
  });

  await user.click(trigger);
  await user.keyboard("{Escape}");
  expect(trigger).toHaveAttribute("aria-expanded", "false");
  expect(trigger).toHaveFocus();
});

/*
 * Collapsing keeps every destination reachable — it trades the label for a tooltip, it does not
 * remove the row. A collapsed sidebar that hides destinations is just a broken sidebar.
 */
test("collapses to icons without losing a destination, and persists the choice", async () => {
  const user = userEvent.setup();
  render(<ShellStub initialEntries={["/inbox"]} />);

  await user.click(screen.getByRole("button", { name: "Collapse sidebar" }));
  const nav = screen.getByRole("navigation", { name: "Main" });

  for (const label of ["Chats", "Inbox", "Resources", "Agents", "Farm"]) {
    expect(within(nav).getByRole("link", { name: label })).toBeInTheDocument();
  }
  expect(within(nav).queryByRole("heading", { name: "Work" })).not.toBeInTheDocument();
  expect(screen.getByRole("complementary", { name: "Application navigation" }).className).toContain(
    "lg:w-14"
  );
  expect(localStorage.getItem("sidebar-collapsed")).toBe("true");
  expect(document.documentElement.dataset.sidebar).toBe("collapsed");

  await user.click(screen.getByRole("button", { name: "Expand sidebar" }));
  expect(localStorage.getItem("sidebar-collapsed")).toBe("false");
  expect(within(nav).getByRole("heading", { name: "Work" })).toBeInTheDocument();
});

/* The skeleton in index.html reads [data-sidebar], so the shell must adopt it on first render. */
test("opens already collapsed when that is the persisted choice", () => {
  document.documentElement.dataset.sidebar = "collapsed";
  render(<ShellStub initialEntries={["/inbox"]} />);

  expect(screen.getByRole("button", { name: "Expand sidebar" })).toBeInTheDocument();
  expect(screen.getByRole("complementary", { name: "Application navigation" }).className).toContain(
    "lg:w-14"
  );
});

test("keeps the sidebar off-canvas on mobile instead of pinning it over the page", () => {
  render(<ShellStub initialEntries={["/farm"]} />);
  const aside = screen.getByRole("complementary", { name: "Application navigation" });

  expect(aside.className).toContain("-translate-x-full");
  expect(aside.className).toContain("lg:translate-x-0");
});

test("renders the shared top bar and restores focus after Escape closes navigation", async () => {
  const user = userEvent.setup();
  render(<ShellStub initialEntries={["/resources"]} />);
  expect(screen.getAllByText("Resources")).toHaveLength(2);
  expect(screen.getByText("Page content")).toBeInTheDocument();
  expect(screen.getAllByRole("main")).toHaveLength(1);
  expect(screen.getByRole("main")).toHaveAttribute("id", "main-content");

  const opener = screen.getByRole("button", { name: "Open navigation" });
  await user.click(opener);
  expect(opener).toHaveAttribute("aria-expanded", "true");
  await user.keyboard("{Escape}");
  expect(opener).toHaveAttribute("aria-expanded", "false");
  expect(opener).toHaveFocus();
});

test("names the chat itself in the top bar", () => {
  useConversations.mockReturnValue({
    ...CONVERSATIONS,
    activeChatId: "c1",
    activeChatTitle: "Q3 pricing review",
  });
  render(<ShellStub initialEntries={["/chat/c1"]} />);

  expect(screen.getByText("Q3 pricing review")).toHaveAttribute("aria-current", "page");
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

  expect(screen.getByText("New chat", { selector: "span[aria-current]" })).toBeInTheDocument();
});

test("renders the report a bug button in the top bar", () => {
  render(<ShellStub initialEntries={["/inbox"]} />);
  expect(screen.getByRole("button", { name: "Report a bug" })).toBeInTheDocument();
});

/*
 * Active used to be `bg-sidebar-accent` and hover the same token at 60% — a 4% lightness step that
 * read as "slightly dirty grey" rather than "you are here". Pin the brand tint so it cannot drift
 * back, and pin the shared box model that keeps every icon on one vertical spine.
 */
test("marks the active destination with the brand tint, not the hover grey", () => {
  render(<SidebarStub initialEntries={["/agents"]} />);

  const active = screen.getByRole("link", { name: "Agents" });
  const idle = screen.getByRole("link", { name: "Skills" });

  expect(active).toHaveAttribute("aria-current", "page");
  expect(active.className).toContain("bg-sidebar-primary/12");
  expect(active.className).toContain("text-sidebar-primary");

  expect(idle.className).not.toContain("bg-sidebar-primary");
  expect(idle.className).toContain("hover:bg-sidebar-accent");
  expect(idle.className).not.toContain("hover:bg-sidebar-accent/");
});

test("gives every row the same box model as the bordered New chat button", () => {
  render(<SidebarStub initialEntries={["/agents"]} />);

  for (const name of ["Agents", "Skills", "Inbox"]) {
    expect(screen.getByRole("link", { name }).className).toContain("border border-transparent");
  }
});
