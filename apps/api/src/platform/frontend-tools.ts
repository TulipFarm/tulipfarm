import { ajv } from "@tulipfarm/schema";
import { err, ok, type RequestContext, type ToolCallResult, type ToolDef } from "../tools/types";

/**
 * Frontend tools + shared state (A2UI Phase 3). Unlike platform tools (which only see the static
 * PlatformToolContext), these are raw `ToolDef`s so their `execute` receives the per-request
 * `RequestContext` — `get_client_context` reads `ctx.clientContext` (what the user is viewing) and
 * flips `ctx.contextRead`; the action tools (navigate_to / prefill_form / invoke_action) return a
 * descriptor the producer emits as a `client-action` SSE event the web shell executes. Side-effecting
 * actions are HARD-GATED behind a `get_client_context` read so the agent acts on where the user is.
 */

function firstError(errors: ReturnType<typeof ajv.compile>["errors"]): string {
  const e = errors?.[0];
  return e
    ? `${e.instancePath || "(root)"} ${e.message ?? "is invalid"}`.trim()
    : "invalid arguments";
}

// Side-effecting actions require the agent to have read the client context first (so it knows where
// the user is). Returns a denial the model sees — it then calls get_client_context and retries.
function requireContextRead(ctx: RequestContext): ToolCallResult | null {
  if (ctx.contextRead && !ctx.contextRead.value) {
    return err(
      "validation_error",
      "Call get_client_context first so you act on the user's current view."
    );
  }
  return null;
}

// ── get_client_context ──────────────────────────────────────────────────────────

const EMPTY_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {},
};

export const getClientContextTool: ToolDef = {
  name: "get_client_context",
  tier: "platform",
  mutating: false,
  description:
    "Read what the user is currently looking at in the app — the current route and page title. Call this to ground answers in the user's view (e.g. the resource record they have open) and BEFORE any navigate / prefill / invoke action.",
  inputSchema: EMPTY_SCHEMA,
  execute: async (_args, ctx) => {
    if (ctx.contextRead) ctx.contextRead.value = true;
    const cc = ctx.clientContext;
    if (!cc || (!cc.route && !cc.title)) {
      return ok({ available: false, route: null, title: null });
    }
    return ok({ available: true, route: cc.route ?? null, title: cc.title ?? null });
  },
};

// ── navigate_to ─────────────────────────────────────────────────────────────────

const NAVIGATE_TO_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["to"],
  properties: {
    to: {
      type: "string",
      minLength: 1,
      pattern: "^/(?!/)",
      description: 'An internal app path starting with "/", e.g. "/resources/tickets/TICK-1042".',
    },
    reason: {
      type: "string",
      description: "A short note shown to the user for why you navigated.",
    },
  },
};
const validateNavigateTo = ajv.compile(NAVIGATE_TO_SCHEMA);

export const navigateToTool: ToolDef = {
  name: "navigate_to",
  tier: "platform",
  mutating: false,
  description:
    "Navigate the user to an internal app route (must start with '/'). Use to open a page or record you just referenced. Requires a get_client_context read first so you don't move the user somewhere they already are.",
  inputSchema: NAVIGATE_TO_SCHEMA,
  execute: async (args, ctx) => {
    const denied = requireContextRead(ctx);
    if (denied) return denied;
    if (!validateNavigateTo(args))
      return err("validation_error", firstError(validateNavigateTo.errors));
    const { to, reason } = args as { to: string; reason?: string };
    return ok({ action: "navigate", to, reason: reason ?? null });
  },
};

// ── prefill_form ──────────────────────────────────────────────────────────────

const PREFILL_FORM_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["values"],
  properties: {
    values: {
      type: "object",
      description:
        "Field name → value to set on the form the user has open (matched by the input's name / data-name). The user reviews and confirms — you do not submit for them.",
    },
    reason: { type: "string" },
  },
};
const validatePrefillForm = ajv.compile(PREFILL_FORM_SCHEMA);

export const prefillFormTool: ToolDef = {
  name: "prefill_form",
  tier: "platform",
  mutating: false,
  description:
    "Pre-fill the form the user currently has open with proposed values (matched by field name) for them to review and confirm — you do not submit. Read get_client_context first to confirm a relevant form is on screen.",
  inputSchema: PREFILL_FORM_SCHEMA,
  execute: async (args, ctx) => {
    const denied = requireContextRead(ctx);
    if (denied) return denied;
    if (!validatePrefillForm(args))
      return err("validation_error", firstError(validatePrefillForm.errors));
    const { values, reason } = args as { values: Record<string, unknown>; reason?: string };
    return ok({ action: "prefill", values, reason: reason ?? null });
  },
};

// ── invoke_action ───────────────────────────────────────────────────────────────

const INVOKE_ACTION_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["name"],
  properties: {
    name: {
      type: "string",
      minLength: 1,
      description: "The registered client action name to invoke.",
    },
    payload: { type: "object", description: "Arguments passed to the client action handler." },
    reason: { type: "string" },
  },
};
const validateInvokeAction = ajv.compile(INVOKE_ACTION_SCHEMA);

export const invokeActionTool: ToolDef = {
  name: "invoke_action",
  tier: "platform",
  mutating: false,
  description:
    "Invoke a named client-side action the current page registered (the page decides what each action does). Read get_client_context first so you only invoke actions available on the user's current view.",
  inputSchema: INVOKE_ACTION_SCHEMA,
  execute: async (args, ctx) => {
    const denied = requireContextRead(ctx);
    if (denied) return denied;
    if (!validateInvokeAction(args))
      return err("validation_error", firstError(validateInvokeAction.errors));
    const { name, payload, reason } = args as {
      name: string;
      payload?: Record<string, unknown>;
      reason?: string;
    };
    return ok({ action: "invoke", name, payload: payload ?? {}, reason: reason ?? null });
  },
};

/** Frontend tools, registered as raw ToolDefs so they receive the per-request RequestContext. */
export const FRONTEND_TOOLS: ToolDef[] = [
  getClientContextTool,
  navigateToTool,
  prefillFormTool,
  invokeActionTool,
];

/** Tool names whose result the producer turns into a `client-action` SSE event for the web shell. */
export const CLIENT_ACTION_TOOLS = new Set<string>([
  "navigate_to",
  "prefill_form",
  "invoke_action",
]);

/** The `client-action` SSE payload for a frontend-action tool result, or null for any other tool. */
export function clientActionEvent(toolName: string, result: ToolCallResult): unknown | null {
  if (!CLIENT_ACTION_TOOLS.has(toolName) || !result.success) return null;
  return result.data;
}
