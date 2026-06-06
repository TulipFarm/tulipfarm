import type { Static, TSchema } from "@sinclair/typebox";
import { ajv } from "./ajv";
import type { ValidationBoundary } from "./boundaries";
import { TulipFarmValidationError } from "./error";

export function validate<T extends TSchema>(
  boundary: ValidationBoundary,
  schema: T,
  data: unknown
): asserts data is Static<T> {
  const check = ajv.compile(schema);
  if (!check(data)) {
    const e = check.errors?.[0] ?? { instancePath: "", message: "Validation failed" };
    throw new TulipFarmValidationError(boundary, e.instancePath, e.message ?? "Validation failed");
  }
}
