import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { MarkdownView } from "./markdown-view";

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
