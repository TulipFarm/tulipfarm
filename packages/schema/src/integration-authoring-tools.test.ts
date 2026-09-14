import { describe, expect, it } from "vitest";
import {
  INTEGRATION_AUTHORING_TOOL_DECLARATIONS,
  INTEGRATION_DRAFT_CREATE_TOOL_DECLARATION,
  INTEGRATION_DRAFT_REVIEW_TOOL_DECLARATION,
} from "./integration-authoring-tools";
import { OIM_FILE_ROLES } from "./oim";

describe("Integration authoring Tool declarations", () => {
  it("requires exact reviewed bytes before an approval-gated publication", () => {
    expect(INTEGRATION_DRAFT_REVIEW_TOOL_DECLARATION.mutating).toBe(false);
    expect(INTEGRATION_DRAFT_REVIEW_TOOL_DECLARATION.inputSchema.required).toEqual(["manifest"]);
    expect(
      INTEGRATION_DRAFT_REVIEW_TOOL_DECLARATION.inputSchema.properties.files.items.properties.role
        .enum
    ).toEqual(OIM_FILE_ROLES);

    expect(INTEGRATION_DRAFT_CREATE_TOOL_DECLARATION.mutating).toBe(true);
    expect(INTEGRATION_DRAFT_CREATE_TOOL_DECLARATION.inputSchema.required).toEqual([
      "slug",
      "package_digest",
    ]);
    expect(INTEGRATION_DRAFT_CREATE_TOOL_DECLARATION.inputSchema.additionalProperties).toBe(false);
    expect(INTEGRATION_AUTHORING_TOOL_DECLARATIONS.map((tool) => tool.name)).toEqual([
      "integration_draft_review",
      "integration_draft_create",
      "integration_get",
      "integration_list",
    ]);
  });
});
