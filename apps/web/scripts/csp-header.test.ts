import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { cspHeaderForHtml, inlineScriptHashes } from "./csp-header";

describe("CSP header generation", () => {
  it("hashes every non-empty inline script and permits Ajv eval", () => {
    const first = "window.__first = true;";
    const second = "window.__second = true;";
    const html = `<script>${first}</script><script src="/assets/app.js"></script><script> ${second} </script>`;
    const hashes = inlineScriptHashes(html);
    const header = cspHeaderForHtml(html);

    expect(hashes).toHaveLength(2);
    expect(header).toContain("script-src 'self' 'unsafe-eval'");
    for (const content of [first, ` ${second} `]) {
      const hash = `'sha256-${createHash("sha256").update(content).digest("base64")}'`;
      expect(header).toContain(hash);
    }
    expect(header).not.toMatch(/script-src[^;]*'unsafe-inline'/);
  });

  it("fails when the final HTML has no inline scripts", () => {
    expect(() => cspHeaderForHtml('<script src="/assets/app.js"></script>')).toThrow(
      "no non-empty inline scripts"
    );
  });
});
