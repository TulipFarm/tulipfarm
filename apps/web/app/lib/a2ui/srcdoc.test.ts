import { expect, test } from "vitest";
import { buildSrcdoc } from "~/lib/a2ui/srcdoc";

const base = {
  sanitizedHtml: "<tf-card>hi</tf-card>",
  tokensCss: ":root{--primary:red}",
  theme: "light" as const,
  nonce: "NONCE123",
};

test("embeds a strict CSP that blocks external network", () => {
  const doc = buildSrcdoc(base);
  expect(doc).toContain('http-equiv="Content-Security-Policy"');
  expect(doc).toContain("default-src 'none'");
  expect(doc).toContain("connect-src 'none'");
  expect(doc).toContain("img-src data:");
});

test("scopes scripts to the per-render nonce", () => {
  const doc = buildSrcdoc(base);
  expect(doc).toContain("script-src 'nonce-NONCE123'");
  expect(doc).toContain('<script nonce="NONCE123">');
});

test("injects the design tokens verbatim", () => {
  expect(buildSrcdoc(base)).toContain(":root{--primary:red}");
});

test("reflects the theme on <html>", () => {
  expect(buildSrcdoc({ ...base, theme: "dark" })).toContain('<html data-theme="dark">');
});

test("embeds the sanitized body", () => {
  expect(buildSrcdoc(base)).toContain("<body><tf-card>hi</tf-card></body>");
});

test("never grants same-origin to the sandbox", () => {
  expect(buildSrcdoc(base)).not.toContain("allow-same-origin");
});

test("includes the in-iframe runtime", () => {
  expect(buildSrcdoc(base)).toContain("window.__a2ui");
});

test("embeds the tf-* component stylesheet", () => {
  const doc = buildSrcdoc(base);
  expect(doc).toContain("tf-card");
  expect(doc).toContain("tf-metric-card");
  expect(doc).toContain("tf-data-table");
});

test("orders styles before the runtime script (reset, then components, then script)", () => {
  const doc = buildSrcdoc(base);
  const resetIdx = doc.indexOf("box-sizing:border-box");
  const compIdx = doc.indexOf("tf-card");
  const scriptIdx = doc.indexOf("<script nonce=");
  expect(resetIdx).toBeGreaterThan(-1);
  expect(resetIdx).toBeLessThan(compIdx);
  expect(compIdx).toBeLessThan(scriptIdx);
});

test("keeps the component stylesheet inside a <style>, not a script", () => {
  const doc = buildSrcdoc(base);
  const compIdx = doc.indexOf("tf-card");
  const styleOpen = doc.lastIndexOf("<style>", compIdx);
  const styleClose = doc.indexOf("</style>", compIdx);
  expect(styleOpen).toBeGreaterThan(-1);
  expect(styleClose).toBeGreaterThan(styleOpen);
});
