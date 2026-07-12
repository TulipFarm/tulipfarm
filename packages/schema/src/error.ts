import type { ValidationBoundary } from "./boundaries";

export class TulipFarmValidationError extends Error {
  readonly boundary: ValidationBoundary;
  readonly path: string;

  constructor(boundary: ValidationBoundary, path: string, message: string) {
    super(message);
    this.name = "TulipFarmValidationError";
    this.boundary = boundary;
    this.path = path;
  }
}
