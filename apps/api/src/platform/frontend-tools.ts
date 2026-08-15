import { ajv } from "@tulipfarm/schema";
import {
  defineApiTool,
  err,
  ok,
  type RequestContext,
  type ToolCallResult,
  type ToolDef,
  toToolDef,
} from "@tulipfarm/tool-host";

function firstError(errors: ReturnType<typeof ajv.compile>["errors"]): string {
  const e = errors?.[0];
  return e
    ? `${e.instancePath || "(root)"} ${e.message ?? "is invalid"}`.trim()
    : "invalid arguments";
}

function requireContextRead(ctx: RequestContext): ToolCallResult | null {
  if (ctx.contextRead && !ctx.contextRead.value) {
    return err(
      "validation_error",
      "Call get_client_context first so you act on the user's current view."
    );
  }
  return null;
}

function frontendRouteTarget(args: unknown) {
  const route = typeof args === "object" && args !== null && "to" in args ? args.to : undefined;
  return typeof route === "string" && route.length > 0
    ? [{ type: "platform.frontend", id: `route:${route}` }]
    : [];
}

function frontendActionTarget(args: unknown) {
  const name = typeof args === "object" && args !== null && "name" in args ? args.name : undefined;
  return typeof name === "string" && name.length > 0
    ? [{ type: "platform.frontend", id: `action:${name}` }]
    : [];
}

const EMPTY_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {},
};

const getClientContextToolDefinition = defineApiTool<RequestContext>({
  name: "get_client_context",
  tier: "platform",
  mutating: false,
  description:
    "Read what the user is currently looking at in the app — the current route and page title. Call this to ground answers in the user's view (e.g. the resource record they have open) and BEFORE any navigate / prefill / invoke action.",
  inputSchema: EMPTY_SCHEMA,
  authorization: {
    action: "frontend.read_context",
    resources: ["platform.frontend"],
    dataClasses: ["operational"],
  },
  availableTo: { requiresWebChat: true },
  handler: async (_args, ctx) => {
    if (ctx.contextRead) ctx.contextRead.value = true;
    const cc = ctx.clientContext;
    if (!cc || (!cc.route && !cc.title)) {
      return ok({ available: false, route: null, title: null });
    }
    return ok({ available: true, route: cc.route ?? null, title: cc.title ?? null });
  },
});

export const getClientContextTool: ToolDef = toToolDef(
  getClientContextToolDefinition,
  (ctx) => ctx
);

const NAVIGATE_TO_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["to"],
  properties: {
    to: {
      type: "string",
      minLength: 1,
      // "/" then not another "/" (blocks protocol-relative //host). Written without regex
      pattern: "^/([^/].*)?$",
      description: 'An internal app path starting with "/", e.g. "/resources/tickets/TICK-1042".',
    },
    reason: {
      type: "string",
      description: "A short note shown to the user for why you navigated.",
    },
  },
};
const validateNavigateTo = ajv.compile(NAVIGATE_TO_SCHEMA);

const navigateToToolDefinition = defineApiTool<RequestContext>({
  name: "navigate_to",
  tier: "platform",
  mutating: false,
  description:
    "Navigate the user to an internal app route (must start with '/'). Use to open a page or record you just referenced. Requires a get_client_context read first so you don't move the user somewhere they already are.",
  inputSchema: NAVIGATE_TO_SCHEMA,
  authorization: {
    action: "frontend.navigate",
    resources: ["platform.frontend"],
    targets: frontendRouteTarget,
    dataClasses: ["operational"],
  },
  availableTo: { requiresWebChat: true },
  handler: async (args, ctx) => {
    const denied = requireContextRead(ctx);
    if (denied) return denied;
    if (!validateNavigateTo(args))
      return err("validation_error", firstError(validateNavigateTo.errors));
    const { to, reason } = args as { to: string; reason?: string };
    return ok({ action: "navigate", to, reason: reason ?? null });
  },
});

export const navigateToTool: ToolDef = toToolDef(navigateToToolDefinition, (ctx) => ctx);

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

const prefillFormToolDefinition = defineApiTool<RequestContext>({
  name: "prefill_form",
  tier: "platform",
  mutating: false,
  description:
    "Pre-fill the form the user currently has open with proposed values (matched by field name) for them to review and confirm — you do not submit. Read get_client_context first to confirm a relevant form is on screen.",
  inputSchema: PREFILL_FORM_SCHEMA,
  authorization: {
    action: "frontend.prefill_form",
    resources: ["platform.frontend"],
    dataClasses: ["operational"],
  },
  availableTo: { requiresWebChat: true },
  handler: async (args, ctx) => {
    const denied = requireContextRead(ctx);
    if (denied) return denied;
    if (!validatePrefillForm(args))
      return err("validation_error", firstError(validatePrefillForm.errors));
    const { values, reason } = args as { values: Record<string, unknown>; reason?: string };
    return ok({ action: "prefill", values, reason: reason ?? null });
  },
});

export const prefillFormTool: ToolDef = toToolDef(prefillFormToolDefinition, (ctx) => ctx);

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

const invokeActionToolDefinition = defineApiTool<RequestContext>({
  name: "invoke_action",
  tier: "platform",
  mutating: false,
  description:
    "Invoke a named client-side action the current page registered (the page decides what each action does). Read get_client_context first so you only invoke actions available on the user's current view.",
  inputSchema: INVOKE_ACTION_SCHEMA,
  authorization: {
    action: "frontend.invoke_action",
    resources: ["platform.frontend"],
    targets: frontendActionTarget,
    dataClasses: ["operational"],
  },
  availableTo: { requiresWebChat: true },
  handler: async (args, ctx) => {
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
});

export const invokeActionTool: ToolDef = toToolDef(invokeActionToolDefinition, (ctx) => ctx);

export const FRONTEND_TOOLS: ToolDef[] = [
  getClientContextTool,
  navigateToTool,
  prefillFormTool,
  invokeActionTool,
];

export const CLIENT_ACTION_TOOLS = new Set<string>([
  "navigate_to",
  "prefill_form",
  "invoke_action",
]);

/** The `client-action` SSE payload, or null for any other tool. */
export function clientActionEvent(toolName: string, result: ToolCallResult): unknown | null {
  if (!CLIENT_ACTION_TOOLS.has(toolName) || !result.success) return null;
  return result.data;
}
