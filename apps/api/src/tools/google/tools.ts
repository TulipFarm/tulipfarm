import { createHash } from "node:crypto";
import { GOOGLE_TOOL_CONTRACTS, GOOGLE_TOOL_IDS, type GoogleToolId } from "@tulipfarm/integrations";
import type { MutationGuard } from "@tulipfarm/observability";
import {
  EffectDispatcher,
  type EffectStore,
  intentDigest,
  normalizeToolIntent,
  ToolCatalog,
  ToolDispatchError,
  type ToolIntent,
} from "@tulipfarm/tool-broker";
import {
  defineApiTool,
  err,
  ok,
  type RequestContext,
  type ToolCallResult,
  type ToolDef,
  toToolDef,
} from "@tulipfarm/tool-host";
import type { GoogleTooling } from "./compose";
import { GOOGLE_ACCESS_TOKEN_SECRET_REF } from "./credentials";

/** Google chat Tools route through the effect ledger, exactly like the Slack and GitHub families. */

const GOOGLE_CATALOG = ToolCatalog.load(GOOGLE_TOOL_CONTRACTS);
const GOOGLE_RESOURCE = "integration.google";

interface GoogleToolSpec {
  readonly name: string;
  readonly description: string;
}

const GOOGLE_TOOL_SPECS: Record<GoogleToolId, GoogleToolSpec> = {
  [GOOGLE_TOOL_IDS.gmailSearch]: {
    name: "gmail_search",
    description:
      "Search the connected Gmail account with Gmail's own query operators (e.g. " +
      "'from:alice@acme.com is:unread newer_than:7d'). Returns matching messages with their id, " +
      "sender, subject, date, and snippet. Use the returned id with gmail_read for the full body.",
  },
  [GOOGLE_TOOL_IDS.gmailRead]: {
    name: "gmail_read",
    description:
      "Read one Gmail message by id (from gmail_search): its sender, recipients, subject, date, " +
      "and full plain-text body.",
  },
  [GOOGLE_TOOL_IDS.gmailDraft]: {
    name: "gmail_draft",
    description:
      "Create a Gmail draft (never sends it) addressed to one or more recipients, with a subject " +
      "and plain-text body. Pass threadId to draft a reply within an existing thread. The user " +
      "reviews and sends the draft themselves from Gmail.",
  },
  [GOOGLE_TOOL_IDS.calendarListEvents]: {
    name: "calendar_list_events",
    description:
      "List upcoming Google Calendar events, optionally filtered by a free-text query and an " +
      "RFC 3339 time window (timeMin/timeMax). Defaults to the primary calendar from now onward. " +
      "Returns each event's id, summary, start, end, location, and attendees.",
  },
  [GOOGLE_TOOL_IDS.calendarCreateEvent]: {
    name: "calendar_create_event",
    description:
      "Create a Google Calendar event with a summary, start, and end. Times are RFC 3339 " +
      "(2026-03-01T14:00:00Z) or an all-day date (2026-03-01). Optionally set description, " +
      "location, and attendee emails. Defaults to the primary calendar.",
  },
  [GOOGLE_TOOL_IDS.driveSearch]: {
    name: "drive_search",
    description:
      "Search Google Drive. Plain keywords match a file's name and full text; a raw Drive query " +
      "with an operator (e.g. \"mimeType='application/pdf'\") is used as-is. Returns each file's " +
      "id, name, type, last-modified time, and a link to open it.",
  },
  [GOOGLE_TOOL_IDS.docsRead]: {
    name: "docs_read",
    description:
      "Read a Google Doc by id (from drive_search or the document URL). Returns its title and " +
      "full plain-text body.",
  },
  [GOOGLE_TOOL_IDS.docsCreate]: {
    name: "docs_create",
    description:
      "Create a new Google Doc with a title and optional initial body text. Returns the new " +
      "document id and a link to open it.",
  },
  [GOOGLE_TOOL_IDS.docsAppend]: {
    name: "docs_append",
    description:
      "Append plain text to the end of an existing Google Doc, identified by its document id.",
  },
};

/** Dresses a digest as an RFC 4122 v4 uuid for durable effect ids. */
function derivedId(...parts: readonly string[]): string {
  const digest = createHash("sha256").update(parts.join(":")).digest("hex");
  const version = `4${digest.slice(13, 16)}`;
  const variant = ((Number.parseInt(digest.slice(16, 17), 16) & 0x3) | 0x8).toString(16);
  return [
    digest.slice(0, 8),
    digest.slice(8, 12),
    version,
    `${variant}${digest.slice(17, 20)}`,
    digest.slice(20, 32),
  ].join("-");
}

function mapDispatchError(error: ToolDispatchError): ToolCallResult {
  if (error.code === "invalid_output")
    return err("internal_error", "Google returned an unexpected response shape");
  if (error.detail === "credential_missing" || error.detail === "credential_denied") {
    return err(
      "not_found",
      "No connected Google account could supply a credential. Connect Google Workspace in " +
        "Integrations, then retry."
    );
  }
  if (error.detail === "provider_not_found") {
    return err("not_found", "Google could not find that message — check the id and retry.");
  }
  if (error.detail === "provider_rate_limited" || error.detail === "provider_unavailable") {
    return err("unavailable", "Google is temporarily unavailable; try again shortly.");
  }
  return err("internal_error", error.detail ? `${error.code}:${error.detail}` : error.message);
}

/** Replayed effect: settled state only, no retained Google response body. */
function replayed(state: string): ToolCallResult {
  switch (state) {
    case "confirmed":
      return ok({ replayed: true, note: "This action already completed; not repeated." });
    case "denied":
      return err("internal_error", "effect_denied");
    case "failed":
      return err("internal_error", "effect_failed");
    default:
      return err("internal_error", `effect_${state}`);
  }
}

export interface GoogleToolingContext extends GoogleTooling {
  readonly effects: EffectStore;
  readonly mutationGuard?: MutationGuard;
}

function buildToolDef(
  toolId: GoogleToolId,
  businessId: string,
  tooling: GoogleToolingContext
): ToolDef {
  const contract = GOOGLE_CATALOG.get(toolId, "1.0.0");
  if (contract === undefined) {
    throw new Error(`google tool contract not published: ${toolId}`);
  }
  const spec = GOOGLE_TOOL_SPECS[toolId];

  const definition = defineApiTool<RequestContext>({
    name: spec.name,
    tier: "integration",
    mutating: contract.mutating,
    description: spec.description,
    inputSchema: contract.inputSchema,
    outputSchema: contract.outputSchema,
    authorization: {
      action: contract.action,
      resources: [GOOGLE_RESOURCE],
      dataClasses: contract.dataClasses,
      allowedDestinations: contract.allowedDestinations,
    },
    riskClass: contract.riskClass,
    credentialMode: "service",
    provider: "google",
    idempotency: contract.idempotency.strategy,
    timeout: contract.timeout,
    retry: contract.retry,
    version: contract.toolVersion,
    async handler(args, ctx): Promise<ToolCallResult> {
      const runId = ctx.runId;
      if (runId === undefined) return err("internal_error", "no run context for this tool call");
      const callId = ctx.toolCallId ?? crypto.randomUUID();
      const stateId = `invoke:${callId}`;

      const rawIntent: ToolIntent = {
        intentId: derivedId("google-intent", runId, stateId, toolId),
        businessId,
        runId,
        stateId,
        toolId,
        toolVersion: contract.toolVersion,
        action: toolId,
        targetRefs: definition.targetsFor(args, ctx),
        arguments: args,
        credentialRef: GOOGLE_ACCESS_TOKEN_SECRET_REF,
        idempotencyKey: derivedId("google-idempotency", runId, stateId, toolId),
      };
      const intent = normalizeToolIntent(rawIntent);
      const effectId = derivedId("google-effect", runId, stateId, toolId);

      const reserved = await tooling.effects.reserve({
        effectId,
        businessId,
        runId,
        stateId,
        logicalEffectOrdinal: 0,
        idempotencyKey: intent.idempotencyKey,
        intentDigest: intentDigest(intent),
        intent,
        guardrailRevision: ctx.guardrailRevision ?? "none",
        createdAt: new Date().toISOString(),
      });

      if (reserved.outcome === "duplicate") return replayed(reserved.effect.state);

      const dispatcher = new EffectDispatcher({
        store: tooling.effects,
        catalog: GOOGLE_CATALOG,
        adapters: tooling.adapters,
        credentialDispatcher: tooling.credentials,
        ...(tooling.mutationGuard === undefined
          ? {}
          : {
              mutationGuard: tooling.mutationGuard,
              mutationIdentity: { integrationId: "google" },
            }),
      });

      try {
        const output = await dispatcher.dispatch(
          businessId,
          reserved.effect.effectId,
          ctx.abortSignal
        );
        return ok(output);
      } catch (error) {
        if (error instanceof ToolDispatchError) return mapDispatchError(error);
        throw error;
      }
    },
  });

  return toToolDef(definition, (ctx) => ctx);
}

export function buildGoogleTools(businessId: string, tooling: GoogleToolingContext): ToolDef[] {
  return GOOGLE_TOOL_CONTRACTS.map((contract) =>
    buildToolDef(contract.spec.toolId as GoogleToolId, businessId, tooling)
  );
}
