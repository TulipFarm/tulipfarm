import { describe, expect, it } from "vitest";
import { firstJsonObject, jsonModeInstruction } from "./structured";

describe("firstJsonObject", () => {
  it("extracts a bare object", () => {
    expect(firstJsonObject('{"a":1}')).toBe('{"a":1}');
  });

  it("extracts an object wrapped in prose and a code fence", () => {
    // The realistic shape: no CLI provider has a native response_format, so the model answers in
    // prose-plus-JSON and this is what has to survive it.
    const text = 'Sure!\n```json\n{"name":"Tulip","count":3}\n```\nHope that helps.';
    expect(firstJsonObject(text)).toBe('{"name":"Tulip","count":3}');
  });

  it("balances nested objects rather than stopping at the first brace", () => {
    expect(firstJsonObject('prefix {"a":{"b":{"c":1}}} suffix')).toBe('{"a":{"b":{"c":1}}}');
  });

  it("ignores braces inside strings", () => {
    expect(firstJsonObject('{"a":"} not the end {"}')).toBe('{"a":"} not the end {"}');
  });

  it("ignores an escaped quote inside a string", () => {
    expect(firstJsonObject('{"a":"say \\"hi\\" }"}')).toBe('{"a":"say \\"hi\\" }"}');
  });

  it("returns undefined when there is no object at all", () => {
    expect(firstJsonObject("no json here")).toBeUndefined();
  });

  it("returns undefined for a truncated object", () => {
    expect(firstJsonObject('{"a":1')).toBeUndefined();
  });

  it("returns undefined rather than a malformed candidate", () => {
    expect(firstJsonObject("{not: valid}")).toBeUndefined();
  });

  it("does not treat a top-level array as an object", () => {
    expect(firstJsonObject("[1,2,3]")).toBeUndefined();
  });
});

describe("jsonModeInstruction", () => {
  it("forbids prose and code fences", () => {
    const instruction = jsonModeInstruction(undefined, undefined);
    expect(instruction).toContain("single JSON object only");
    expect(instruction).toContain("no markdown code fence");
  });

  it("names the object and inlines the schema when both are known", () => {
    const instruction = jsonModeInstruction(
      { type: "object", properties: { a: { type: "string" } } },
      "SkillAudit"
    );
    expect(instruction).toContain("SkillAudit");
    expect(instruction).toContain('{"type":"object","properties":{"a":{"type":"string"}}}');
  });
});
