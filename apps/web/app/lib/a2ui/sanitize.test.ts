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

test("preserves tf-data-table wrapping a native <table> with aria-sort headers", () => {
  const html =
    '<tf-data-table><table><thead><tr><th aria-sort="ascending">name</th><th>status</th></tr></thead>' +
    "<tbody><tr><td>Item A</td><td>active</td></tr></tbody></table></tf-data-table>";
  const out = sanitizeAgentHtml(html);
  expect(out).toContain("<tf-data-table>");
  for (const tag of ["<table>", "<thead>", "<tbody>", "<tr>", "<th", "<td>"]) {
    expect(out).toContain(tag);
  }
  expect(out).toContain('aria-sort="ascending"'); // presentational sort glyph hook survives
  expect(out).toContain("Item A");
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

test("preserves tf-schema-form + native form controls with data-* config and slot children", () => {
  const html = `
    <tf-schema-form>
      <div data-slot="field">
        <span data-slot="label">email <span data-slot="req">*</span></span>
        <tf-input><input type="email" data-name="email" placeholder="you@ex.com"></tf-input>
        <span data-slot="error">required</span>
      </div>
      <div data-slot="field">
        <tf-textarea><textarea data-name="bio" rows="4"></textarea></tf-textarea>
      </div>
      <div data-slot="field">
        <tf-select><select data-name="status"><option>open</option><option selected>closed</option></select></tf-select>
      </div>
      <div data-slot="field">
        <tf-radio-group><label><input type="radio" name="priority" checked> low</label><label><input type="radio" name="priority"> high</label></tf-radio-group>
      </div>
      <div data-slot="field">
        <tf-checkbox><label><input type="checkbox" data-name="active" checked> active</label></tf-checkbox>
      </div>
      <div data-slot="field">
        <tf-switch><label><input type="checkbox" data-name="notify" checked> notify</label></tf-switch>
      </div>
      <div data-slot="field">
        <tf-combobox><input data-name="customerId" placeholder="Search customer" value="Acme Corp"><ul><li aria-selected="true">Acme Corp</li><li>Globex</li></ul></tf-combobox>
      </div>
      <div data-slot="field">
        <tf-calendar><input type="date" data-name="due" value="2026-06-12"></tf-calendar>
      </div>
      <div data-slot="field" data-immutable>
        <span data-slot="label">id <span data-slot="meta">(immutable)</span></span>
        <tf-input><input data-name="id" value="TICK-1042" disabled></tf-input>
      </div>
      <tf-button>Save</tf-button>
    </tf-schema-form>`;
  const out = sanitizeAgentHtml(html);

  // every new tf-* form wrapper survives
  for (const tag of [
    "tf-schema-form",
    "tf-input",
    "tf-textarea",
    "tf-select",
    "tf-radio-group",
    "tf-checkbox",
    "tf-switch",
    "tf-combobox",
    "tf-calendar",
  ]) {
    expect(out).toContain(`<${tag}`);
  }

  // native form controls survive (DOMPurify default allowlist)
  for (const tag of ["<input", "<textarea", "<select", "<option", "<ul>", "<li"]) {
    expect(out).toContain(tag);
  }

  // control config attributes the skins / future runtime rely on survive
  expect(out).toContain('type="email"');
  expect(out).toContain('type="date"');
  expect(out).toContain('type="radio"');
  expect(out).toContain('type="checkbox"');
  expect(out).toContain('placeholder="you@ex.com"');
  expect(out).toContain('value="2026-06-12"');
  expect(out).toContain("checked");
  expect(out).toContain("disabled");
  expect(out).toContain("selected");

  // identity + slot markers ride the always-safe data-/aria- channel (never name/id — SANITIZE_DOM)
  expect(out).toContain('data-name="email"');
  expect(out).toContain('data-slot="field"');
  expect(out).toContain('data-slot="error"');
  expect(out).toContain("data-immutable");
  expect(out).toContain('aria-selected="true"');

  // style= is still stripped even amid the form markup
  expect(out).not.toContain("style=");
});
