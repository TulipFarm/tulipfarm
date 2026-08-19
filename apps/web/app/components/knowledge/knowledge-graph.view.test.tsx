/**
 * The view test. `buildGraphModel` is proved separately; what is asserted here is the part that
 * only exists in the DOM — that the same information is reachable without seeing the picture, and
 * that nothing rendered counts higher than what is drawn.
 */
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { KnowledgeGraph } from "~/lib/knowledge-api";
import { KnowledgeGraphView } from "./knowledge-graph";

vi.mock("@remix-run/react", () => ({
  useNavigate: () => vi.fn(),
}));

function graph(partial: Partial<KnowledgeGraph>): KnowledgeGraph {
  return { nodes: [], edges: [], spaces: [], truncated: false, ...partial };
}

const two = graph({
  nodes: [
    { id: "a", path: "runbook", title: "Runbook", spaceId: "eng" },
    { id: "b", path: "oncall", title: "On-call", spaceId: "ops" },
  ],
  edges: [{ sourceId: "a", targetId: "b" }],
  spaces: [
    { id: "eng", name: "Engineering" },
    { id: "ops", name: "Ops" },
  ],
});

describe("the Business-wide graph view", () => {
  it("offers the same information as a list, not only as a drawing", () => {
    render(<KnowledgeGraphView graph={two} />);
    const list = screen.getByTestId("graph-outline");
    expect(within(list).getByRole("link", { name: /Runbook/ })).toBeTruthy();
    expect(within(list).getByRole("link", { name: /On-call/ })).toBeTruthy();
  });

  it("names, in the list, which Space each Page came from", () => {
    render(<KnowledgeGraphView graph={two} />);
    expect(screen.getByTestId("graph-outline").textContent).toContain("Engineering");
  });

  it("states the counts it drew, and no others", () => {
    render(<KnowledgeGraphView graph={two} />);
    const caption = screen.getByTestId("graph-counts").textContent ?? "";
    expect(caption).toContain("2 pages");
    expect(caption).toContain("1 link");
  });

  it("says a graph is partial when it is, rather than passing a cap off as the whole corpus", () => {
    render(<KnowledgeGraphView graph={{ ...two, truncated: true }} />);
    expect(screen.getByTestId("graph-truncated")).toBeTruthy();
  });

  it("says nothing about truncation when nothing was truncated", () => {
    render(<KnowledgeGraphView graph={two} />);
    expect(screen.queryByTestId("graph-truncated")).toBeNull();
  });

  it("renders an explanation rather than a blank canvas when there is nothing to draw", () => {
    render(<KnowledgeGraphView graph={graph({})} />);
    expect(screen.getByTestId("graph-empty")).toBeTruthy();
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("renders a lone Page as a Page rather than as an error", () => {
    render(
      <KnowledgeGraphView
        graph={graph({
          nodes: [{ id: "a", path: "runbook", title: "Runbook", spaceId: "eng" }],
          spaces: [{ id: "eng", name: "Engineering" }],
        })}
      />
    );
    expect(screen.queryByTestId("graph-empty")).toBeNull();
    expect(screen.getByTestId("graph-counts").textContent).toContain("1 page");
    expect(within(screen.getByTestId("graph-outline")).getByRole("link")).toBeTruthy();
  });
});
