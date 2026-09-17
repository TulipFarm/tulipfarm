import { describe, expect, it } from "vitest";
import { ajv } from "./ajv";
import {
  RECORD_DELETE_PREVIEW_TOOL_DECLARATION,
  RECORD_DELETE_TOOL_DECLARATION,
} from "./record-delete-tools";

describe("Record deletion Tool declarations", () => {
  it("requires the exact versioned preview shape for cascade deletion", () => {
    const validate = ajv.compile(RECORD_DELETE_TOOL_DECLARATION.inputSchema);
    const plan = {
      id: "plan-1",
      root: { type: "customer", id: "C-1", version: 3 },
      records: [
        { type: "customer", id: "C-1", version: 3 },
        { type: "ticket", id: "T-8", version: 2 },
      ],
      restrictedBy: [],
    };

    expect(validate({ type: "customer", id: "C-1", version: 3, plan })).toBe(true);
    expect(
      validate({
        type: "customer",
        id: "C-1",
        version: 3,
        plan: { ...plan, records: [{ type: "ticket", id: "T-8" }] },
      })
    ).toBe(false);
  });

  it("ships preview as a non-mutating Tool", () => {
    expect(RECORD_DELETE_PREVIEW_TOOL_DECLARATION).toMatchObject({
      name: "record_delete_preview",
      mutating: false,
    });
  });
});
