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
  renderWiki("See [Runbook](/knowledge/concepts/abc/runbook).");
  const link = screen.getByRole("link", { name: "Runbook" });
  expect(link).toHaveAttribute("href", "/knowledge/concepts/abc/runbook");
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
