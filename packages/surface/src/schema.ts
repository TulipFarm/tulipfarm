import type { TSchema } from "@sinclair/typebox";
import { ajv } from "@tulipfarm/schema/ajv";

export interface SurfaceSchemaIssue {
  readonly path: string;
  readonly message: string;
}

export function surfaceSchemaIssues(
  schema: TSchema,
  value: unknown
): readonly SurfaceSchemaIssue[] {
  try {
    const validate = ajv.compile(schema);
    if (validate(value)) return [];
    return (validate.errors ?? []).map((error) => ({
      path: error.instancePath,
      message: error.message ?? "is invalid",
    }));
  } catch (error) {
    return [
      {
        path: "",
        message: `Invalid component schema: ${error instanceof Error ? error.message : String(error)}`,
      },
    ];
  }
}
