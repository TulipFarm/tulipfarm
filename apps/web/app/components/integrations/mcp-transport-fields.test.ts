import { expect, test } from "vitest";
import { transportDraft, transportInput } from "./mcp-transport-fields";

test("accepts an explicit HTTPS remote MCP endpoint", () => {
  expect(transportInput({ ...transportDraft(), url: "https://mcp.example.com/mcp" })).toEqual({
    type: "streamable-http",
    url: "https://mcp.example.com/mcp",
  });
});

test.each([
  "http://mcp.example.com",
  "https://token:secret@mcp.example.com",
  "https://mcp.example.com/#secret",
  "https://mcp.example.com/?access_token=not-a-real-token",
  "https://mcp.example.com/?API_KEY=not-a-real-token",
  "https://mcp.example.com/?client-secret=not-a-real-token",
])("refuses unsafe endpoint %s", (url) => {
  expect(() => transportInput({ ...transportDraft(), url })).toThrow();
});

test("preserves isolated local arguments without interpreting shell syntax", () => {
  const transport = {
    type: "stdio" as const,
    image: `registry.example.com/server@sha256:${"a".repeat(64)}`,
    command: "/app/server",
    args: ["--name", "two words", "$(not-executed)"],
    allowedEgress: ["api.example.com"],
  };
  expect(transportInput(transportDraft(transport))).toEqual(transport);
});

test("refuses mutable images and outbound URL patterns", () => {
  const draft = {
    ...transportDraft(),
    type: "stdio" as const,
    image: "server:latest",
    command: "/app/server",
  };
  expect(() => transportInput(draft)).toThrow("sha256");
  expect(() =>
    transportInput({
      ...draft,
      image: `server@sha256:${"a".repeat(64)}`,
      allowedEgress: "*.example.com",
    })
  ).toThrow("hostname");
});
