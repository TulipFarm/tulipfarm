/**
 * The Action constraints, as plain values rather than a schema.
 *
 * `contracts.ts` builds `SurfaceActionSchema` from these and the browser entry checks against them
 * directly, because a renderer that disagreed with the validator about what an Action is would
 * either drop a legal Action or offer one the server then rejects.
 */

export const SURFACE_ACTION_EVENT_PATTERN = "^[a-z][a-z0-9_.-]*$";
export const SURFACE_ACTION_EVENT_MIN_LENGTH = 1;
export const SURFACE_ACTION_EVENT_MAX_LENGTH = 128;

export const SURFACE_ACTION_KEYS = ["disabled", "event", "payload", "stepUp"] as const;

export type SurfaceActionKey = (typeof SURFACE_ACTION_KEYS)[number];
