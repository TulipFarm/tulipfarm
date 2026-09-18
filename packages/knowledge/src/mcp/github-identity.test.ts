import { describe, expect, it } from "vitest";
import { parseGithubKnowledgeIdentity } from "./github-file";

describe("parseGithubKnowledgeIdentity", () => {
  it("returns only the validated provider id, not profile text", () => {
    expect(
      parseGithubKnowledgeIdentity({
        content: [{ type: "text", text: '{"id":42,"login":"muskan"}' }],
      })
    ).toBe("42");
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "42", null])(
    "refuses invalid numeric identity %j",
    (id) => {
      expect(() =>
        parseGithubKnowledgeIdentity({
          content: [{ type: "text", text: JSON.stringify({ id }) }],
        })
      ).toThrow("identity_mismatch");
    }
  );

  it("refuses provider errors, malformed JSON and extra response parts", () => {
    expect(() => parseGithubKnowledgeIdentity({ isError: true, content: [] })).toThrow(
      "source_unavailable"
    );
    expect(() =>
      parseGithubKnowledgeIdentity({ content: [{ type: "text", text: "not JSON" }] })
    ).toThrow("source_response_invalid");
    expect(() =>
      parseGithubKnowledgeIdentity({
        content: [
          { type: "text", text: '{"id":42}' },
          { type: "text", text: '{"id":43}' },
        ],
      })
    ).toThrow("source_response_invalid");
  });
});
