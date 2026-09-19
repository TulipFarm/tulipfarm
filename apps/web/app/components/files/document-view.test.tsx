import { render, screen, waitFor } from "@testing-library/react";
import { projectDocument } from "@tulipfarm/files/document-preview";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchFileBytes = vi.fn();
vi.mock("~/lib/files", () => ({ fetchFileBytes: (...args: unknown[]) => fetchFileBytes(...args) }));

const renderAsync = vi.fn();
const renderPresentation = vi.fn();
vi.mock("docx-preview", () => ({ renderAsync: (...args: unknown[]) => renderAsync(...args) }));
vi.mock("pptx-preview", () => ({
  init: () => ({ preview: (...args: unknown[]) => renderPresentation(...args), destroy: () => {} }),
}));

const previewDocx = vi.fn();
vi.mock("./docx-preview-client", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  previewDocument: (...args: unknown[]) => previewDocx(...args),
}));

const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const PPTX = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

const { DocumentView } = await import("./document-view");
const { DocxPreviewFailure } = await import("./docx-preview-client");

function semantic(text: string, truncated = false) {
  return {
    blocks: [{ kind: "paragraph", text }],
    truncated,
  };
}

function resolveWith(text: string) {
  const bytes = new TextEncoder().encode(text);
  fetchFileBytes.mockResolvedValue({ bytes, text: () => text });
}

describe("DocumentView", () => {
  beforeEach(() => {
    fetchFileBytes.mockReset();
    renderAsync.mockReset();
    renderPresentation.mockReset().mockResolvedValue(undefined);
    previewDocx.mockReset();
  });

  it("draws a Word file with the full-fidelity renderer rather than as an outline", async () => {
    resolveWith("PK-docx-bytes");
    renderAsync.mockResolvedValue(undefined);
    render(<DocumentView file={{ id: "d1", filename: "a.docx", mediaType: DOCX }} />);

    await waitFor(() => expect(renderAsync).toHaveBeenCalled());
    expect(screen.queryByText("outline text")).not.toBeInTheDocument();
    expect(previewDocx).not.toHaveBeenCalled();
  });

  it("falls back to the outline when the renderer refuses the document", async () => {
    resolveWith("PK-docx-bytes");
    previewDocx.mockResolvedValue(semantic("outline text"));
    renderAsync.mockRejectedValue(new Error("unsupported"));
    render(<DocumentView file={{ id: "d2", filename: "b.docx", mediaType: DOCX }} />);

    expect(await screen.findByText("outline text")).toBeInTheDocument();
  });

  it("says a document is unreadable rather than crashing when both paths fail", async () => {
    resolveWith("PK-docx-bytes");
    previewDocx.mockRejectedValue(new DocxPreviewFailure("malformed"));
    renderAsync.mockRejectedValue(new Error("unsupported"));
    render(<DocumentView file={{ id: "d3", filename: "c.docx", mediaType: DOCX }} />);

    expect(await screen.findByRole("alert")).toHaveTextContent(/damaged or incomplete/);
    expect(screen.queryByText(/no readable content/)).not.toBeInTheDocument();
  });

  it("discloses cropped semantic previews separately from extraction", async () => {
    resolveWith("PK-docx-bytes");
    previewDocx.mockResolvedValue(semantic("Visible excerpt", true));
    renderAsync.mockRejectedValue(new Error("unsupported"));
    render(<DocumentView file={{ id: "limited", filename: "long.docx", mediaType: DOCX }} />);

    expect(await screen.findByText(/Limited preview/)).toHaveAttribute("role", "status");
    expect(screen.getByText(/400 blocks and 200 rows/)).toBeInTheDocument();
  });

  it("distinguishes a successful empty document from a parse refusal", async () => {
    resolveWith("PK-docx-bytes");
    previewDocx.mockResolvedValue(semantic("   \n"));
    renderAsync.mockRejectedValue(new Error("unsupported"));
    render(<DocumentView file={{ id: "empty", filename: "empty.docx", mediaType: DOCX }} />);

    expect(await screen.findByText(/no readable content/)).toHaveAttribute("role", "status");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("retains the original bytes after the rich renderer consumes its copy", async () => {
    resolveWith("PK-original-document");
    previewDocx.mockResolvedValue(semantic("Recovered"));
    renderAsync.mockImplementation(async (copy: Uint8Array) => {
      copy.fill(0);
      throw new Error("unsupported");
    });
    render(<DocumentView file={{ id: "copy", filename: "copy.docx", mediaType: DOCX }} />);

    expect(await screen.findByText("Recovered")).toBeInTheDocument();
    expect(previewDocx.mock.calls[0]?.[0]).toEqual(
      new TextEncoder().encode("PK-original-document")
    );
  });

  it("renders shared semantic headings, nested lists and notes without active source markup or URLs", async () => {
    resolveWith("PK-docx-bytes");
    const paragraph = (text: string) => ({
      kind: "paragraph",
      content: [{ kind: "text", text }],
    });
    previewDocx.mockResolvedValue(
      projectDocument({
        blocks: [
          { kind: "heading", level: 2, content: [{ kind: "text", text: "Document heading" }] },
          paragraph("<script>window.stolen = true</script><svg onload='alert(1)'/>"),
          {
            kind: "paragraph",
            content: [
              {
                kind: "link",
                target: { kind: "external", value: "https://example.invalid/track" },
                content: [{ kind: "text", text: "External reference" }],
              },
              {
                kind: "image",
                alt: "External diagram",
                source: { kind: "external", url: "https://example.invalid/pixel" },
              },
              { kind: "noteRef", noteId: "1" },
            ],
          },
          {
            kind: "list",
            list: {
              marker: "decimal",
              start: 1,
              items: [
                {
                  blocks: [
                    paragraph("First task"),
                    {
                      kind: "list",
                      list: {
                        marker: "bullet",
                        start: 1,
                        items: [{ blocks: [paragraph("Nested task")] }],
                      },
                    },
                  ],
                },
              ],
            },
          },
        ],
        notes: [{ kind: "footnote", id: "1", blocks: [paragraph("Grounded supporting note")] }],
        assets: [{ id: 0, mediaType: "image/svg+xml", data: new Uint8Array([1, 2, 3]) }],
      })
    );
    renderAsync.mockRejectedValue(new Error("unsupported"));
    const { container } = render(
      <DocumentView file={{ id: "safe", filename: "safe.docx", mediaType: DOCX }} />
    );
    expect(await screen.findByRole("heading", { name: "Document heading" })).toBeInTheDocument();
    expect(screen.getByText("Nested task")).toBeInTheDocument();
    expect(container.querySelector("ol ul")).not.toBeNull();
    expect(screen.getByText("Grounded supporting note")).toBeInTheDocument();
    expect(screen.getByText(/External reference.*External diagram/)).toBeInTheDocument();
    expect(screen.getByText(/<script>window.stolen/)).toBeInTheDocument();
    expect(container.querySelector("script, svg, img, a, iframe, object, embed")).toBeNull();
  });

  it("cancels a superseded fallback and ignores its late content", async () => {
    resolveWith("PK-docx-bytes");
    let complete: ((value: ReturnType<typeof semantic>) => void) | undefined;
    previewDocx.mockImplementation(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        })
    );
    renderAsync.mockRejectedValue(new Error("unsupported"));
    const { rerender } = render(
      <DocumentView file={{ id: "old", filename: "old.docx", mediaType: DOCX }} />
    );
    await screen.findByText("Reading Word document locally…");
    const signal = previewDocx.mock.calls[0]?.[1] as AbortSignal;
    resolveWith("Current file");
    rerender(<DocumentView file={{ id: "new", filename: "new.txt", mediaType: "text/plain" }} />);
    expect(signal.aborted).toBe(true);
    complete?.(semantic("Stale private content"));
    expect(await screen.findByText("Current file")).toBeInTheDocument();
    expect(screen.queryByText("Stale private content")).not.toBeInTheDocument();
  });

  it("retains shared Word table spans and explicit headers without inventing a header row", async () => {
    resolveWith("PK-docx-bytes");
    const origin = (text: string, rowSpan = 1, colSpan = 1) => ({
      kind: "origin",
      cell: {
        blocks: [{ kind: "paragraph", content: [{ kind: "text", text }] }],
        rowSpan,
        colSpan,
      },
    });
    const covered = { kind: "covered", originRow: 0, originCol: 0 };
    previewDocx.mockResolvedValue(
      projectDocument({
        blocks: [
          {
            kind: "table",
            table: {
              kind: "data",
              headerRows: 1,
              grid: [
                [origin("Merged heading", 2, 2), covered, origin("Other heading")],
                [covered, covered, origin("Associated value")],
              ],
            },
          },
          {
            kind: "table",
            table: { kind: "data", headerRows: 0, grid: [[origin("Ordinary first row")]] },
          },
        ],
        notes: [],
      })
    );
    renderAsync.mockRejectedValue(new Error("unsupported"));
    render(<DocumentView file={{ id: "spans", filename: "spans.docx", mediaType: DOCX }} />);

    const heading = await screen.findByRole("columnheader", { name: "Merged heading" });
    expect(heading).toHaveAttribute("rowspan", "2");
    expect(heading).toHaveAttribute("colspan", "2");
    expect(screen.getAllByRole("columnheader")).toHaveLength(2);
    expect(screen.getAllByRole("cell")).toHaveLength(2);
    expect(screen.getByRole("cell", { name: "Associated value" })).toBeInTheDocument();
    expect(screen.getByRole("cell", { name: "Ordinary first row" })).toBeInTheDocument();
  });

  it("preserves PowerPoint's rich default and the spreadsheet grid path", async () => {
    resolveWith("PK-office-bytes");
    const { rerender } = render(
      <DocumentView file={{ id: "deck", filename: "deck.pptx", mediaType: PPTX }} />
    );
    await waitFor(() =>
      expect(fetchFileBytes).toHaveBeenCalledWith("deck", expect.any(AbortSignal))
    );
    expect(previewDocx).not.toHaveBeenCalled();
    previewDocx.mockResolvedValue({
      blocks: [
        { kind: "heading", level: 2, text: "Orders" },
        { kind: "table", rows: [["Item"], ["Tulips"]], headerRows: 1 },
      ],
      truncated: true,
    });
    rerender(<DocumentView file={{ id: "sheet", filename: "orders.xlsx", mediaType: XLSX }} />);
    expect(await screen.findByRole("table")).toBeInTheDocument();
    expect(screen.getByText("Tulips")).toBeInTheDocument();
    expect(previewDocx.mock.calls[0]).toEqual([
      new TextEncoder().encode("PK-office-bytes"),
      expect.any(AbortSignal),
      "xlsx",
    ]);
    expect(screen.getByText(/Visible sheets, rows and columns only/)).toBeInTheDocument();
    expect(screen.getByText(/Limited preview/)).toBeInTheDocument();
  });

  it("falls back from rich PowerPoint to labeled notes without inventing slide cards", async () => {
    resolveWith("PK-presentation-bytes");
    renderPresentation.mockRejectedValue(new Error("unsupported deck layout"));
    previewDocx.mockResolvedValue({
      blocks: [
        { kind: "heading", level: 2, text: "Approval briefing" },
        { kind: "paragraph", text: "Visible review instructions" },
        { kind: "heading", level: 3, text: "Speaker notes" },
        { kind: "paragraph", text: "Approval expires after 47 days." },
      ],
      truncated: false,
    });
    render(<DocumentView file={{ id: "notes", filename: "notes.pptx", mediaType: PPTX }} />);
    expect(await screen.findByText("Approval expires after 47 days.")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Speaker notes" })).toBeInTheDocument();
    expect(screen.queryByText(/^Slide \d/)).not.toBeInTheDocument();
    expect(previewDocx.mock.calls[0]?.[2]).toBe("pptx");
    expect(screen.getByText(/does not reproduce slide boundaries/)).toBeInTheDocument();
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
