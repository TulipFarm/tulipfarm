import { describe, expect, it } from "vitest";
import { compileA2UISurface } from "./compile";

describe("compileA2UISurface", () => {
  it("escapes bound values and emits only the signed descriptor for actions", () => {
    const compiled = compileA2UISurface(
      {
        version: "1",
        root: {
          component: "Card",
          children: [
            { component: "Text", text: { path: "/message" } },
            {
              component: "Button",
              label: "Approve",
              action: { descriptor: "payload.signature" },
            },
          ],
        },
      },
      { message: `"><script>steal()</script>` }
    );

    expect(compiled.html).toContain("&lt;script&gt;steal()&lt;/script&gt;");
    expect(compiled.html).not.toContain("<script>");
    expect(compiled.html).toContain("&quot;descriptor&quot;:&quot;payload.signature&quot;");
    expect(compiled.html).not.toContain("event");
    expect(compiled.nodeIds).toEqual(["a2-0", "a2-1", "a2-2"]);
  });

  it("fails closed instead of rendering an unknown component", () => {
    expect(() =>
      compileA2UISurface({
        root: { component: "iframe", src: "https://evil.example" },
      })
    ).toThrow(/A2UI schema/);
  });
});
