import { createRemixStub } from "@remix-run/testing";
import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { MarkdownView } from "./markdown-view";

function renderWiki(md: string) {
  const Stub = createRemixStub([
    { path: "/", Component: () => <MarkdownView wikiLinks>{md}</MarkdownView> },
  ]);
  render(<Stub initialEntries={["/"]} />);
}

test("renders headings, lists, and external links from markdown", () => {
  render(
    <MarkdownView>
      {"# Title\n\nSome **text**.\n\n- one\n- two\n\n[docs](https://example.com)"}
    </MarkdownView>
  );
  expect(screen.getByRole("heading", { name: "Title" })).toBeInTheDocument();
  expect(screen.getByText("one")).toBeInTheDocument();
  const link = screen.getByRole("link", { name: "docs" });
  expect(link).toHaveAttribute("href", "https://example.com");
  expect(link).toHaveAttribute("target", "_blank");
});

test("linkifies inline [n] citation markers to their cited page, leaving unknown refs plain", () => {
  const Stub = createRemixStub([
    {
      path: "/",
      Component: () => (
        <MarkdownView citations={[{ ref: 1, url: "/knowledge/pages/d1" }]}>
          {"Refunds take 5 days [1] but disputes differ [2]."}
        </MarkdownView>
      ),
    },
  ]);
  render(<Stub initialEntries={["/"]} />);
  // [1] has a resolved source → in-app link; [2] has no source → stays literal text.
  const cite = screen.getByRole("link", { name: "[1]" });
  expect(cite).toHaveAttribute("href", "/knowledge/pages/d1");
  // Citations open the source in a new tab (so the chat thread isn't navigated away from).
  expect(cite).toHaveAttribute("target", "_blank");
  expect(screen.queryByRole("link", { name: "[2]" })).toBeNull();
  expect(screen.getByText(/disputes differ \[2\]\./)).toBeInTheDocument();
});

test("linkifies every occurrence of a known ref and leaves an interleaved unknown ref as text", () => {
  const Stub = createRemixStub([
    {
      path: "/",
      Component: () => (
        <MarkdownView citations={[{ ref: 1, url: "/knowledge/pages/d1" }]}>
          {"a [1] b [2] c [1] d"}
        </MarkdownView>
      ),
    },
  ]);
  render(<Stub initialEntries={["/"]} />);
  // Both `[1]` markers link; the unknown `[2]` stays literal text.
  expect(screen.getAllByRole("link", { name: "[1]" })).toHaveLength(2);
  expect(screen.queryByRole("link", { name: "[2]" })).toBeNull();
  expect(screen.getByText(/b \[2\] c/)).toBeInTheDocument();
});

test("renders no citation links when none are provided (plain [n] text)", () => {
  render(<MarkdownView>{"see note [1] here"}</MarkdownView>);
  expect(screen.queryByRole("link")).toBeNull();
  expect(screen.getByText(/see note \[1\] here/)).toBeInTheDocument();
});

test("renders GFM tables", () => {
  render(<MarkdownView>{"| a | b |\n| - | - |\n| 1 | 2 |"}</MarkdownView>);
  expect(screen.getByRole("table")).toBeInTheDocument();
  expect(screen.getByRole("columnheader", { name: "a" })).toBeInTheDocument();
});

test("renders a GitHub-alert blockquote as a callout with the marker stripped", () => {
  const { container } = render(<MarkdownView>{"> [!WARNING]\n> Be careful."}</MarkdownView>);
  expect(container.querySelector('[data-callout="WARNING"]')).not.toBeNull();
  expect(screen.getByText("WARNING")).toBeInTheDocument();
  expect(screen.getByText(/Be careful\./)).toBeInTheDocument();
  expect(container.textContent).not.toContain("[!WARNING]");
});

test("leaves a plain blockquote untouched (no callout)", () => {
  const { container } = render(<MarkdownView>{"> just a quote"}</MarkdownView>);
  expect(container.querySelector("blockquote")).not.toBeNull();
  expect(container.querySelector("[data-callout]")).toBeNull();
  expect(screen.getByText("just a quote")).toBeInTheDocument();
});

test("wikiLinks: renders an internal page link as a client link (no new tab)", () => {
  renderWiki("See [Runbook](/knowledge/pages/abc/runbook).");
  const link = screen.getByRole("link", { name: "Runbook" });
  expect(link).toHaveAttribute("href", "/knowledge/pages/abc/runbook");
  expect(link).not.toHaveAttribute("target");
});

test("wikiLinks: renders #tag text as a chip link to the tag listing", () => {
  renderWiki("Flagged #urgent today.");
  const chip = screen.getByRole("link", { name: "#urgent" });
  expect(chip).toHaveAttribute("href", "/knowledge/tags/urgent");
  expect(chip).toHaveClass("tf-tag-chip");
});

test("wikiLinks: renders an unresolved tf: link as muted text, not a link", () => {
  renderWiki("See [Ghost](tf:page/Unknown/x).");
  expect(screen.queryByRole("link", { name: "Ghost" })).toBeNull();
  expect(screen.getByText("Ghost")).toBeInTheDocument();
});

test("without wikiLinks, external links still open in a new tab", () => {
  render(<MarkdownView>{"[docs](https://example.com)"}</MarkdownView>);
  expect(screen.getByRole("link", { name: "docs" })).toHaveAttribute("target", "_blank");
});

test("wikiLinks + citations compose: both an internal page link and a [n] citation linkify", () => {
  const Stub = createRemixStub([
    {
      path: "/",
      Component: () => (
        <MarkdownView wikiLinks citations={[{ ref: 1, url: "/knowledge/pages/d1" }]}>
          {"See [Runbook](/knowledge/pages/abc/runbook) for refunds [1]."}
        </MarkdownView>
      ),
    },
  ]);
  render(<Stub initialEntries={["/"]} />);
  // Wiki internal link is still a client link (not lost to the citation renderer)…
  const wiki = screen.getByRole("link", { name: "Runbook" });
  expect(wiki).toHaveAttribute("href", "/knowledge/pages/abc/runbook");
  expect(wiki).not.toHaveAttribute("target");
  // …and the citation marker still linkifies to its cited page, opening in a new tab.
  const cite = screen.getByRole("link", { name: "[1]" });
  expect(cite).toHaveAttribute("href", "/knowledge/pages/d1");
  expect(cite).toHaveAttribute("target", "_blank");
});
