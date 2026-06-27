import { createRemixStub } from "@remix-run/testing";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "~/lib/knowledge-api";
import { buildPageResolver } from "~/lib/page-href";
import { HistoryDrawer } from "./history-panel";

vi.mock("~/lib/knowledge-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/lib/knowledge-api")>();
  return { ...actual, listRevisions: vi.fn(), writePage: vi.fn() };
});

const REVS = [
  {
    id: "r2",
    pageId: "doc1",
    revisionNumber: 2,
    content: "---\ntitle: Note\n---\n\nsecond body",
    reason: "space renamed Sales → Revenue",
    createdAt: "2026-06-22T14:30:00.000Z",
  },
  {
    id: "r1",
    pageId: "doc1",
    revisionNumber: 1,
    content: "---\ntitle: Note\n---\n\nfirst body",
    reason: null,
    createdAt: "2026-06-21T09:00:00.000Z",
  },
];

function renderDrawer(open: boolean) {
  const Stub = createRemixStub([
    {
      path: "/",
      Component: () => (
        <HistoryDrawer
          open={open}
          onClose={vi.fn()}
          pageId="doc1"
          spaceId="eng"
          path="note"
          resolver={buildPageResolver([])}
          currentContent={"---\ntitle: Note (current)\n---\n\ncurrent body"}
          currentUpdatedAt="2026-06-25T12:00:00.000Z"
        />
      ),
    },
  ]);
  render(<Stub initialEntries={["/"]} />);
}

describe("HistoryDrawer", () => {
  beforeEach(() => {
    vi.mocked(api.listRevisions).mockReset();
    vi.mocked(api.writePage).mockReset();
  });

  it("does not fetch revisions while closed", () => {
    vi.mocked(api.listRevisions).mockResolvedValue({ items: REVS });
    renderDrawer(false);
    expect(api.listRevisions).not.toHaveBeenCalled();
  });

  it("loads and lists revisions when opened", async () => {
    vi.mocked(api.listRevisions).mockResolvedValue({ items: REVS });
    renderDrawer(true);
    expect(await screen.findByText(/#2 ·/)).toBeInTheDocument();
    expect(screen.getByText(/#1 ·/)).toBeInTheDocument();
    expect(screen.getByText(/space renamed Sales → Revenue/)).toBeInTheDocument();
    expect(api.listRevisions).toHaveBeenCalledWith("doc1");
  });

  it("shows a Current entry + a title-change summary vs the previous version", async () => {
    vi.mocked(api.listRevisions).mockResolvedValue({ items: REVS });
    renderDrawer(true);
    expect(await screen.findByText(/Current ·/)).toBeInTheDocument();
    expect(screen.getByText("Note (current)")).toBeInTheDocument();
    // Current's title differs from #2 ("Note") → an explicit title diff is surfaced.
    expect(screen.getByText("Title: Note → Note (current)")).toBeInTheDocument();
  });

  it("previews a past revision's body read-only", async () => {
    vi.mocked(api.listRevisions).mockResolvedValue({ items: REVS });
    renderDrawer(true);
    await userEvent.click(await screen.findByRole("button", { name: /#1 ·/ }));
    expect(await screen.findByText("first body")).toBeInTheDocument();
  });

  it("restores a revision via writePage after a two-step confirm", async () => {
    vi.mocked(api.listRevisions).mockResolvedValue({ items: REVS });
    vi.mocked(api.writePage).mockResolvedValue({ id: "doc1", path: "note" } as never);
    renderDrawer(true);
    await screen.findByText(/#1 ·/);

    // Two Restore buttons (one per row); the second is the oldest (#1) revision.
    await userEvent.click(screen.getAllByRole("button", { name: "Restore" })[1]);
    await userEvent.click(screen.getByRole("button", { name: "Confirm restore" }));

    await waitFor(() => expect(api.writePage).toHaveBeenCalledWith("eng", "note", REVS[1].content));
  });
});
