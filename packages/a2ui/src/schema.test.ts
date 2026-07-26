import { describe, expect, it } from "vitest";
import { A2UISchemaError, validateA2UISpec } from "./schema";

describe("validateA2UISpec", () => {
  it("accepts only allowlisted declarative components", () => {
    expect(
      validateA2UISpec({
        version: "1",
        root: {
          component: "Card",
          children: [
            { component: "Heading", text: "Quarterly results" },
            {
              component: "Button",
              label: "Approve",
              action: { descriptor: "signed.descriptor" },
            },
          ],
        },
      })
    ).toMatchObject({ version: "1" });
  });

  it.each([
    {
      root: { component: "Html", html: "<button onclick='steal()'>run</button>" },
    },
    {
      root: { component: "Button", label: "Run", onClick: "dispatch()" },
    },
    {
      root: {
        component: "Button",
        label: "Run",
        action: { descriptor: "signed.descriptor", credential: "plaintext" },
      },
    },
  ])("rejects executable or credential-bearing presentation data", (spec) => {
    expect(() => validateA2UISpec(spec)).toThrow(A2UISchemaError);
  });
});
