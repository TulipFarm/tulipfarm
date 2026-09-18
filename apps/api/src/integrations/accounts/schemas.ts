import { Type } from "@sinclair/typebox";
import { McpAccountGrantSchema } from "@tulipfarm/schema";

export const McpAccountGrantSummarySchema = Type.Object(
  {
    ...McpAccountGrantSchema.properties,
    status: Type.Union([Type.Literal("active"), Type.Literal("stale")]),
  },
  { additionalProperties: false }
);
