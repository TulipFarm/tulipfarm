import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchFileBytes = vi.fn();
vi.mock("~/lib/files", () => ({ fetchFileBytes: (...args: unknown[]) => fetchFileBytes(...args) }));

const renderAsync = vi.fn();
vi.mock("docx-preview", () => ({ renderAsync: (...args: unknown[]) => renderAsync(...args) }));
vi.mock("pptx-preview", () => ({
  init: () => ({ preview: () => Promise.resolve(), destroy: () => {} }),
}));

const previewOffice = vi.fn();
vi.mock("@tulipfarm/files/office-preview", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  previewOffice: (...args: unknown[]) => previewOffice(...args),
}));

const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

const { DocumentView } = await import("./document-view");

function resolveWith(text: string) {
  const bytes = new TextEncoder().encode(text);
  fetchFileBytes.mockResolvedValue({ bytes, text: () => text });
}

describe("DocumentView", () => {
  beforeEach(() => {
    fetchFileBytes.mockReset();
    renderAsync.mockReset();
    previewOffice.mockReset();
  });

  it("draws a Word file with the full-fidelity renderer rather than as an outline", async () => {
    resolveWith("PK-docx-bytes");
    previewOffice.mockReturnValue([{ kind: "paragraph", text: "outline text" }]);
    renderAsync.mockResolvedValue(undefined);
    render(<DocumentView file={{ id: "d1", filename: "a.docx", mediaType: DOCX }} />);

    await vi.waitFor(() => expect(renderAsync).toHaveBeenCalled());
    expect(screen.queryByText("outline text")).not.toBeInTheDocument();
  });

  it("falls back to the outline when the renderer refuses the document", async () => {
    resolveWith("PK-docx-bytes");
    previewOffice.mockReturnValue([{ kind: "paragraph", text: "outline text" }]);
    renderAsync.mockRejectedValue(new Error("unsupported"));
    render(<DocumentView file={{ id: "d2", filename: "b.docx", mediaType: DOCX }} />);

    expect(await screen.findByText("outline text")).toBeInTheDocument();
  });

  it("says a document is unreadable rather than crashing when both paths fail", async () => {
    resolveWith("PK-docx-bytes");
    previewOffice.mockImplementation(() => {
      throw new Error("not a zip");
    });
    renderAsync.mockRejectedValue(new Error("unsupported"));
    render(<DocumentView file={{ id: "d3", filename: "c.docx", mediaType: DOCX }} />);

    expect(await screen.findByText(/no readable content/)).toBeInTheDocument();
  });

  it("renders a CSV as a table rather than as comma-separated text", async () => {
    resolveWith("name,role\nMuskan Vijayvargiya,Engineer");
    render(<DocumentView file={{ id: "f1", filename: "people.csv", mediaType: "text/csv" }} />);

    expect(await screen.findByRole("table")).toBeInTheDocument();
    expect(screen.getByText("name")).toBeInTheDocument();
    expect(screen.getByText("Muskan Vijayvargiya")).toBeInTheDocument();
    // The raw line must not survive: seeing it means the grid was never built.
    expect(screen.queryByText(/name,role/)).not.toBeInTheDocument();
  });

  it("keeps a quoted separator inside one cell", async () => {
    resolveWith('name,note\n"Vijayvargiya, Muskan",hi');
    render(<DocumentView file={{ id: "f2", filename: "q.csv", mediaType: "text/csv" }} />);

    expect(await screen.findByText("Vijayvargiya, Muskan")).toBeInTheDocument();
  });

  it("still shows a plain text file as text", async () => {
    resolveWith("just words");
    render(<DocumentView file={{ id: "f3", filename: "n.txt", mediaType: "text/plain" }} />);

    expect(await screen.findByText("just words")).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("says so when the file cannot be read", async () => {
    fetchFileBytes.mockRejectedValue(new Error("nope"));
    render(<DocumentView file={{ id: "f4", filename: "b.csv", mediaType: "text/csv" }} />);

    expect(await screen.findByText(/could not be opened for preview/)).toBeInTheDocument();
  });
});
