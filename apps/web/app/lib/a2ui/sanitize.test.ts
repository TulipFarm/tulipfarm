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

test("preserves the v1 tf-* component set with data-* config and slot/semantic children", () => {
  const html = `
    <tf-card data-test="1"><tf-heading data-variant="label">h</tf-heading></tf-card>
    <tf-grid data-cols="2"><tf-card>cell</tf-card></tf-grid>
    <tf-text data-tone="muted" data-size="sm">t</tf-text>
    <tf-badge data-variant="danger">b</tf-badge>
    <tf-alert data-tone="danger"><span data-slot="title">e</span>msg</tf-alert>
    <tf-empty-state><span data-slot="title">empty</span></tf-empty-state>
    <tf-list><ul><li>item<span data-slot="meta">m</span></li></ul></tf-list>
    <tf-metric-card data-trend="down"><span data-slot="value">42</span><span data-slot="label">n</span><span data-slot="delta">-3</span></tf-metric-card>
    <tf-detail-view><dl><div><dt>k</dt><dd>v</dd></div></dl></tf-detail-view>
    <tf-button data-variant="outline" data-size="sm">go</tf-button>`;
  const out = sanitizeAgentHtml(html);

  // every in-scope tag survives
  for (const tag of [
    "tf-card",
    "tf-grid",
    "tf-heading",
    "tf-text",
    "tf-badge",
    "tf-alert",
    "tf-empty-state",
    "tf-list",
    "tf-metric-card",
    "tf-detail-view",
    "tf-button",
  ]) {
    expect(out).toContain(`<${tag}`);
  }

  // data-* config attributes survive
  expect(out).toContain('data-variant="label"');
  expect(out).toContain('data-cols="2"');
  expect(out).toContain('data-tone="muted"');
  expect(out).toContain('data-size="sm"');
  expect(out).toContain('data-trend="down"');

  // data-slot markers survive
  expect(out).toContain('data-slot="title"');
  expect(out).toContain('data-slot="value"');
  expect(out).toContain('data-slot="meta"');

  // native semantic children survive inside tf-* wrappers
  expect(out).toContain("<dl>");
  expect(out).toContain("<dt>");
  expect(out).toContain("<dd>");
  expect(out).toContain("<li>");

  // style= is still stripped even amid tf-* content
  expect(out).not.toContain("style=");
});
