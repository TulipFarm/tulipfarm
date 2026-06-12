import { describe, expect, it } from "vitest";
import { ok } from "../tools/types";
import { renderA2uiHtml } from "./a2ui-render";

describe("renderA2uiHtml", () => {
  it("passes compose_view html through unchanged", () => {
    const html = "<tf-card><tf-text>hi</tf-text></tf-card>";
    expect(renderA2uiHtml("compose_view", ok({ html }))).toBe(html);
  });

  it("returns null for compose_view with empty/non-string html", () => {
    expect(renderA2uiHtml("compose_view", ok({ html: "" }))).toBeNull();
    expect(renderA2uiHtml("compose_view", ok({ html: 42 }))).toBeNull();
  });

  it("renders present_choices as one tf-button per choice with a choice payload", () => {
    const html = renderA2uiHtml(
      "present_choices",
      ok({
        question: "Pick a stage",
        choices: [
          { label: "Staging", value: "staging" },
          { label: "Prod", value: "prod", description: "live" },
        ],
      })
    );
    expect(html).not.toBeNull();
    const buttons = [...(html as string).matchAll(/<tf-button /g)];
    expect(buttons).toHaveLength(2);
    expect(html).toContain("Pick a stage");
    expect(html).toContain(
      `data-a2ui-send="${'{"kind":"choice","value":"staging","label":"Staging"}'
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")}"`
    );
    expect(html).toContain("live"); // description rendered
  });

  it("renders suggest_agent as a card with an accept button carrying the agent payload", () => {
    const html = renderA2uiHtml(
      "suggest_agent",
      ok({ agentId: "billing", agentName: "Billing Bot", reason: "handles invoices" })
    );
    expect(html).not.toBeNull();
    expect(html).toContain("Billing Bot");
    expect(html).toContain("handles invoices");
    expect(html).toContain(`&quot;kind&quot;:&quot;suggest_agent&quot;`);
    expect(html).toContain(`&quot;agentId&quot;:&quot;billing&quot;`);
  });

  it("escapes agent-controlled strings so a choice label cannot break out of the attribute/tag", () => {
    const html = renderA2uiHtml(
      "present_choices",
      ok({
        question: "q",
        choices: [{ label: '"><tf-button data-a2ui-send="{}">x', value: "v" }],
      })
    ) as string;
    // The injected markup must be neutralised — no second real button, no raw closing quote+bracket.
    expect(html).not.toContain('"><tf-button data-a2ui-send="{}">');
    expect([...html.matchAll(/<tf-button /g)]).toHaveLength(1);
    expect(html).toContain("&lt;tf-button");
  });

  it("returns null for non-view tools and failed results", () => {
    expect(renderA2uiHtml("load_skill", ok({ name: "x" }))).toBeNull();
    expect(
      renderA2uiHtml("present_choices", {
        success: false,
        error: { code: "validation_error", message: "bad" },
      })
    ).toBeNull();
  });
});
