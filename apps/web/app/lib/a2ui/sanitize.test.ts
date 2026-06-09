import { expect, test } from "vitest";
import { sanitizeAgentHtml } from "~/lib/a2ui/sanitize";

test("strips <script> tags but keeps surrounding markup", () => {
  const out = sanitizeAgentHtml("<p>ok</p><script>alert(1)</script>");
  expect(out).toContain("<p>ok</p>");
  expect(out.toLowerCase()).not.toContain("<script");
});

test("strips inline event handlers", () => {
  const out = sanitizeAgentHtml('<img src="x" onerror="alert(1)">');
  expect(out).not.toContain("onerror");
});

test("neutralizes javascript: URLs", () => {
  const out = sanitizeAgentHtml('<a href="javascript:alert(1)">x</a>');
  expect(out).not.toContain("javascript:");
});

test("strips style attributes (untrusted inline styles are an unneeded surface)", () => {
  const out = sanitizeAgentHtml('<div style="color:red">x</div>');
  expect(out).not.toContain("style=");
});

test("preserves tf-* custom elements with data-* attributes and content", () => {
  const out = sanitizeAgentHtml('<tf-card data-id="1"><tf-heading>Hi</tf-heading></tf-card>');
  expect(out).toContain("<tf-card");
  expect(out).toContain('data-id="1"');
  expect(out).toContain("<tf-heading>");
  expect(out).toContain("Hi");
});

test("preserves an unknown tf-* element (it renders empty later — deferring is safe)", () => {
  const out = sanitizeAgentHtml("<tf-kanban></tf-kanban>");
  expect(out).toContain("<tf-kanban>");
});

test("preserves safe formatting markup", () => {
  const out = sanitizeAgentHtml("<p><strong>bold</strong> and <em>italic</em></p>");
  expect(out).toContain("<strong>bold</strong>");
  expect(out).toContain("<em>italic</em>");
});
