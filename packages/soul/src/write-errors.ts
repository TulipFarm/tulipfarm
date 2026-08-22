import { SoulWriteError } from "./writer";

/**
 * Translate a `SoulWriter.apply` rejection into an HTTP answer.
 *
 * Every Soul-authoring route funnels its gateway failures through here so a caller sees the same
 * status for the same cause no matter which surface it came from. Before the gateway existed each
 * route hand-rolled its own `try/catch` around raw `fs` writes, and the same underlying failure
 * surfaced as a 500 on one route and a 409 on another.
 *
 * `SoulWriteError` carries structured issues and path-shaped evidence, never file content, so the
 * reason a target or a definition was rejected travels to the caller with it. Withholding it cost
 * a QA cycle: `invalid soul write target` alone does not say which of a package's files the
 * gateway refused, or why.
 */
export interface SoulWriteHttpError {
  readonly status: 400 | 404 | 409 | 422 | 500;
  readonly body: { readonly error: string };
}

/** Gateway messages are prefixed for logs; the HTTP body supplies its own subject. */
function reason(error: SoulWriteError): string {
  return error.message.replace(/^Soul write: /, "");
}

export function soulWriteHttpError(error: SoulWriteError): SoulWriteHttpError {
  switch (error.code) {
    case "INVALID_TARGET":
      return { status: 400, body: { error: `invalid soul write target: ${reason(error)}` } };
    case "PRECONDITION_FAILED":
      // The tree moved between the caller's read and its write. From the caller's point of view
      // the thing it addressed is no longer where it thought — a 404, not a server fault.
      return { status: 404, body: { error: "the artifact changed before this write was saved" } };
    case "VALIDATION_FAILED":
      return {
        status: 422,
        body: {
          error:
            error.issues.length > 0
              ? `invalid soul definition: ${error.issues.map((i) => `${i.path} ${i.code}${i.field ? ` at ${i.field}` : ""}`).join("; ")}`
              : `invalid soul definition: ${reason(error)}`,
        },
      };
    case "CONFLICT":
      // Retrying the same bytes would resurrect a stale read, so the caller must re-read first.
      return {
        status: 409,
        body: { error: "another change landed first; reload and try again" },
      };
    default:
      return { status: 500, body: { error: "the soul write could not be committed" } };
  }
}

/** Narrowing helper so routes can keep a single `catch` without an `instanceof` ladder. */
export function isSoulWriteError(e: unknown): e is SoulWriteError {
  return e instanceof SoulWriteError;
}
