import * as remix from "@remix-run/react";
import { createRemixStub } from "@remix-run/testing";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { listAllPages, listSpaces } from "~/lib/knowledge-api";
import KnowledgeLayout from "./_app.knowledge";
import KnowledgeIndex from "./_app.knowledge._index";

vi.mock("@remix-run/react", async () => ({
  ...(await vi.importActual<typeof import("@remix-run/react")>("@remix-run/react")),
  useLoaderData: vi.fn(),
}));
vi.mock("~/lib/knowledge-api", async () => ({
  ...(await vi.importActual<typeof import("~/lib/knowledge-api")>("~/lib/knowledge-api")),
  listSpaces: vi.fn(async () => ({ items: [{ id: "handbook", name: "Handbook" }] })),
  listAllPages: vi.fn(async () => ({ items: [] })),
  getKnowledgeOverview: vi.fn(async () => ({ spaces: [], recent: [] })),
  searchPages: vi.fn(async () => []),
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

function renderKnowledge(desktop = false) {
  let resize = (_event: MediaQueryListEvent) => {};
  vi.spyOn(window, "matchMedia").mockImplementation((media) => ({
    matches: desktop,
    media,
    onchange: null,
    addEventListener: (_name: string, listener: EventListenerOrEventListenerObject | null) => {
      if (listener) {
        resize = (event) =>
          typeof listener === "function" ? listener(event) : listener.handleEvent(event);
      }
    },
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
  vi.mocked(remix.useLoaderData).mockReturnValue({ spaces: [], recent: [] });
  const Stub = createRemixStub([
    {
      path: "/knowledge",
      Component: KnowledgeLayout,
      children: [
        { index: true, Component: KnowledgeIndex },
        { path: "spaces/new", Component: () => <p>Create a space</p> },
      ],
    },
  ]);
  render(<Stub initialEntries={["/knowledge"]} />);
  return (matches: boolean) => act(() => resize({ matches } as MediaQueryListEvent));
}

test("mobile Knowledge has one browse dialog, restores focus, and follows native dismissal", async () => {
  renderKnowledge();
  const browse = screen.getByRole("button", { name: "Browse pages" });
  expect(screen.queryByRole("navigation", { name: "Knowledge" })).not.toBeInTheDocument();
  await userEvent.click(browse);
  const dialog = screen.getByRole("dialog", { name: "Browse pages" });
  expect(await within(dialog).findByRole("link", { name: "Handbook" })).toBeInTheDocument();
  expect(screen.getAllByRole("navigation", { name: "Knowledge" })).toHaveLength(1);
  expect(listSpaces).toHaveBeenCalledTimes(1);
  expect(listAllPages).toHaveBeenCalledTimes(1);
  expect(within(dialog).getByRole("link", { name: "New page in Handbook" })).not.toHaveClass(
    "opacity-0"
  );
  fireEvent(dialog, new Event("close"));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(browse).toHaveFocus();
});

test.each(["button", "keyboard", "keyboard-toggle"])(
  "mobile search restores Browse focus after a %s handoff",
  async (method) => {
    renderKnowledge();
    const user = userEvent.setup();
    const browse = screen.getByRole("button", { name: "Browse pages" });
    const globalSearch = vi.fn();
    const onGlobalShortcut = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "k") globalSearch();
    };
    document.addEventListener("keydown", onGlobalShortcut);
    try {
      await user.click(browse);
      if (method === "button") {
        await user.click(screen.getByRole("button", { name: "Search knowledge" }));
      } else {
        await user.keyboard("{Control>}k{/Control}");
      }
      const search = await screen.findByPlaceholderText("Search knowledge…");
      expect(search).toHaveFocus();
      expect(globalSearch).not.toHaveBeenCalled();
      expect(screen.queryByRole("dialog", { name: "Browse pages" })).not.toBeInTheDocument();
      await user.keyboard(method === "keyboard-toggle" ? "{Control>}k{/Control}" : "{Escape}");
      await waitFor(() =>
        expect(screen.queryByPlaceholderText("Search knowledge…")).not.toBeInTheDocument()
      );
      await waitFor(() => expect(browse).toHaveFocus());
      expect(globalSearch).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener("keydown", onGlobalShortcut);
    }
  }
);

test("mobile browsing closes on navigation", async () => {
  renderKnowledge();
  await userEvent.click(screen.getByRole("button", { name: "Browse pages" }));
  await userEvent.click(
    within(screen.getByRole("dialog")).getByRole("link", { name: "New space" })
  );
  expect(await screen.findByText("Create a space")).toBeInTheDocument();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

test("growing to desktop closes mobile browsing and mounts only one tree", async () => {
  const resize = renderKnowledge();
  await userEvent.click(screen.getByRole("button", { name: "Browse pages" }));
  resize(true);
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Browse pages" })).not.toBeInTheDocument();
  await waitFor(() =>
    expect(screen.getAllByRole("navigation", { name: "Knowledge" })).toHaveLength(1)
  );
});

test("empty Knowledge offers a draft and manual creation without a second page title", () => {
  renderKnowledge();
  const create = screen.getByRole("link", { name: "Start knowledge in chat" });
  expect(
    new URL(create.getAttribute("href") ?? "", "http://localhost").searchParams.get("draft")
  ).toMatch(/knowledge.*space.*page/i);
  expect(screen.getByRole("link", { name: "Create a space manually" })).toHaveAttribute(
    "href",
    "/knowledge/spaces/new"
  );
  expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
  expect(screen.getByRole("heading", { level: 1 })).toHaveClass("sr-only");
  expect(screen.queryByText(/tree on the left/)).not.toBeInTheDocument();
  expect(document.querySelectorAll(".bg-primary")).toHaveLength(1);
});
