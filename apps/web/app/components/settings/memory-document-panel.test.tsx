import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import { getMemoryDocument } from "~/lib/memory-document";
import { MemoryDocumentPanel } from "./memory-document-panel";

vi.mock("~/lib/memory-document", () => ({ getMemoryDocument: vi.fn() }));
vi.mock("~/lib/use-highlighted", () => ({ useHighlighted: () => null }));

const mockGet = vi.mocked(getMemoryDocument);

const DOC = "## Identity\n\nLives in Bangalore\n\n## Preferences\n\nPrefers ASCII diagrams";

beforeEach(() => {
  vi.clearAllMocks();
  mockGet.mockResolvedValue({
    document: DOC,
    characters: DOC.length,
    characterBudget: 20_000,
    updatedAt: "2026-08-17T10:00:00.000Z",
  });
});

test("shows the document as Markdown", async () => {
  render(<MemoryDocumentPanel />);
  expect(await screen.findByLabelText("Memory document")).toHaveTextContent("Lives in Bangalore");
});

test("shows how much of the budget is used", async () => {
  render(<MemoryDocumentPanel />);
  expect(await screen.findByText(new RegExp(`${DOC.length} / 20,000 characters`))).toBeVisible();
});

/**
 * The regression this exists for: Memory is what the system concluded. An editor here would make
 * it a second set of Custom instructions with none of that field's guarantees, and would leave no
 * revision or writer behind a change.
 */
test("offers no way to edit or delete anything", async () => {
  render(<MemoryDocumentPanel />);
  await screen.findByLabelText("Memory document");

  expect(screen.queryByRole("textbox")).toBeNull();
  expect(screen.queryByRole("button")).toBeNull();
});

test("says so when there is nothing yet", async () => {
  mockGet.mockResolvedValue({ document: "", characters: 0, characterBudget: 20_000 });
  render(<MemoryDocumentPanel />);
  expect(await screen.findByText(/nothing yet/i)).toBeVisible();
  expect(screen.queryByLabelText("Memory document")).toBeNull();
});

/** Deployments that do not read memory as a document never register the route. */
test("renders nothing at all when the route is absent", async () => {
  mockGet.mockRejectedValue(new Error("404"));
  const { container } = render(<MemoryDocumentPanel />);
  await waitFor(() => expect(container).toBeEmptyDOMElement());
});
