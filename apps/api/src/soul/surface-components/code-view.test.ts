/**
 * The denylist is ergonomics, not security (see `code-view.ts`), so its failure mode is the one
 * that matters: a refusal an author cannot act on. These pin both halves — a real capability is
 * still refused, and a longer word that merely contains one is not.
 */

import { describe, expect, it } from "vitest";
import { compileSurfaceCodeView } from "./code-view";

async function compile(source: string) {
  return compileSurfaceCodeView("web", source);
}

describe("compileSurfaceCodeView capability denial", () => {
  it("refuses a real capability reference", async () => {
    const denied = [
      "function render() { fetch('https://example.com'); return <div/>; }",
      "function render() { return <div>{window.top.location.href}</div>; }",
      "function render() { return <div>{window.parent.name}</div>; }",
      "function render() { localStorage.setItem('a', 'b'); return <div/>; }",
      "function render() { document.cookie; return <div/>; }",
    ];
    for (const source of denied) {
      expect(await compile(source), source).toHaveProperty("error");
    }
  });

  it("compiles an identifier that merely contains a denied name", async () => {
    const allowed = [
      "function render() { return <div style={{verticalAlign:'top'}}>ok</div>; }",
      "function render() { return <div style={{borderTop:'1px solid #eee'}}>ok</div>; }",
      "function render(props) { return <div>{props.topOffices.length}</div>; }",
      "function render(props) { return <div>{props.parentTeam}</div>; }",
      'function render() { return <div title="fetch the report">ok</div>; }',
    ];
    for (const source of allowed) {
      expect(await compile(source), source).not.toHaveProperty("error");
    }
  });
});
