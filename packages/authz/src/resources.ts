/** Resource names and actions the authorization gate decides against. */

/**
 * The resource-name grammar from `docs/architecture/authorization-design.md` §4.
 *
 * Two levels, exact match — `grantMatches` does no prefix matching, so a grant naming
 * `platform.model` covers that resource and nothing else.
 *
 * `platform.*`, `soul.*` and `authz.*` are closed namespaces and belong here. `record.*` is
 * deliberately open — Resource types are authored at runtime — so it is built, not enumerated.
 */
export const PLATFORM_RESOURCES = [
  "platform.secret",
  "platform.setting",
  "platform.user",
  "platform.integration",
  /**
   * Which model a principal may cause a call to.
   *
   * A chat request names a model as a free string — an effort preset, a ModelProfile ref, or a raw
   * provider model id — and it reached the provider having passed only a capability-fit check.
   * There was no resource to grant or deny against, so "may this principal use this model" was a
   * question the system could not express, let alone answer.
   */
  "platform.model",
] as const;

export type PlatformResource = (typeof PLATFORM_RESOURCES)[number];

/** Causing a model call. The named model is carried as the request's `recordId`. */
export const MODEL_INVOKE_ACTION = "model.invoke";

/** The resource a model selector is decided against. */
export const MODEL_RESOURCE: PlatformResource = "platform.model";
