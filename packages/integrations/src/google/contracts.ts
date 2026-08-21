import {
  canonicalHash,
  type ToolContractDefinition,
  type ToolContractSpec,
} from "@tulipfarm/schema";

/** First-party Google Workspace chat Tools. Step one covers Gmail: search, read, draft. */

export const GOOGLE_ADAPTER_REF = "integration:google";
export const GOOGLE_DESTINATION = "google";

export const GOOGLE_TOOL_IDS = {
  gmailSearch: "google.gmail.search",
  gmailRead: "google.gmail.read",
  gmailDraft: "google.gmail.draft",
  calendarListEvents: "google.calendar.list_events",
  calendarCreateEvent: "google.calendar.create_event",
  calendarUpdateEvent: "google.calendar.update_event",
  calendarDeleteEvent: "google.calendar.delete_event",
  driveSearch: "google.drive.search",
  docsRead: "google.docs.read",
  docsCreate: "google.docs.create",
  docsAppend: "google.docs.append",
} as const;

export type GoogleToolId = (typeof GOOGLE_TOOL_IDS)[keyof typeof GOOGLE_TOOL_IDS];

/** Which Google service host a Tool talks to, so one login can reach four APIs. */
export const GOOGLE_SERVICES = ["gmail", "calendar", "drive", "docs"] as const;
export type GoogleService = (typeof GOOGLE_SERVICES)[number];

const TOOL_VERSION = "1.0.0";
const GMAIL_DATA_CLASSES = ["source_content"];

const gmailSearchInputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["query"],
  properties: {
    query: {
      type: "string",
      minLength: 1,
      maxLength: 500,
      description:
        "A Gmail search query using Gmail's own operators, e.g. 'from:alice@acme.com is:unread " +
        "newer_than:7d' or 'subject:invoice has:attachment'.",
    },
    maxResults: {
      type: "integer",
      minimum: 1,
      maximum: 25,
      description: "How many matching messages to return. Defaults to 10.",
    },
  },
} as const;

const gmailMessageSummarySchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "threadId"],
  properties: {
    id: { type: "string" },
    threadId: { type: "string" },
    from: { type: "string" },
    to: { type: "string" },
    subject: { type: "string" },
    date: { type: "string" },
    snippet: { type: "string" },
  },
} as const;

const gmailSearchOutputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["messages"],
  properties: {
    messages: { type: "array", items: gmailMessageSummarySchema },
  },
} as const;

const gmailReadInputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["messageId"],
  properties: {
    messageId: {
      type: "string",
      minLength: 1,
      maxLength: 128,
      description: "The Gmail message id, as returned by gmail_search.",
    },
  },
} as const;

const gmailReadOutputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "threadId", "body"],
  properties: {
    id: { type: "string" },
    threadId: { type: "string" },
    from: { type: "string" },
    to: { type: "string" },
    cc: { type: "string" },
    subject: { type: "string" },
    date: { type: "string" },
    snippet: { type: "string" },
    body: { type: "string" },
  },
} as const;

const emailAddressList = {
  type: "string",
  minLength: 3,
  maxLength: 1000,
  description: "One or more email addresses, comma-separated.",
} as const;

const gmailDraftInputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["to", "subject", "body"],
  properties: {
    to: { ...emailAddressList, description: "Recipient address(es), comma-separated." },
    subject: { type: "string", maxLength: 998 },
    body: {
      type: "string",
      minLength: 1,
      maxLength: 100_000,
      description: "Plain-text body of the email.",
    },
    cc: emailAddressList,
    bcc: emailAddressList,
    threadId: {
      type: "string",
      maxLength: 128,
      description: "Attach the draft to this Gmail thread to draft a reply in an existing thread.",
    },
  },
} as const;

const gmailDraftOutputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["draftId"],
  properties: {
    draftId: { type: "string" },
    messageId: { type: "string" },
    threadId: { type: "string" },
  },
} as const;

/**
 * Authored definitions are content-addressed. Deriving the digest from the spec keeps these
 * first-party contracts publishable without hand-maintained hashes that would silently drift.
 */
function publish(spec: ToolContractSpec, id: string, slug: string): ToolContractDefinition {
  return {
    apiVersion: "tulipfarm.ai/v1",
    kind: "ToolContract",
    metadata: {
      id,
      slug,
      schemaVersion: 1,
      authoredVersion: 1,
      lifecycle: "published",
      publishedDigest: canonicalHash(spec),
    },
    spec,
  };
}

const gmailSearch = publish(
  {
    toolId: GOOGLE_TOOL_IDS.gmailSearch,
    toolVersion: TOOL_VERSION,
    action: GOOGLE_TOOL_IDS.gmailSearch,
    inputSchema: gmailSearchInputSchema,
    outputSchema: gmailSearchOutputSchema,
    riskClass: "low",
    mutating: false,
    dataClasses: GMAIL_DATA_CLASSES,
    allowedDestinations: [GOOGLE_DESTINATION],
    idempotency: { strategy: "none" },
    timeout: { wallClockMs: 15_000 },
    retry: { maxAttempts: 3, safeToRetry: true },
    dryRun: false,
    adapter: { kind: "integration", ref: GOOGLE_ADAPTER_REF },
  },
  "aaaaaaaa-0005-4000-8000-000000000001",
  "google-gmail-search"
);

const gmailRead = publish(
  {
    toolId: GOOGLE_TOOL_IDS.gmailRead,
    toolVersion: TOOL_VERSION,
    action: GOOGLE_TOOL_IDS.gmailRead,
    inputSchema: gmailReadInputSchema,
    outputSchema: gmailReadOutputSchema,
    riskClass: "low",
    mutating: false,
    dataClasses: GMAIL_DATA_CLASSES,
    allowedDestinations: [GOOGLE_DESTINATION],
    idempotency: { strategy: "none" },
    timeout: { wallClockMs: 15_000 },
    retry: { maxAttempts: 3, safeToRetry: true },
    dryRun: false,
    adapter: { kind: "integration", ref: GOOGLE_ADAPTER_REF },
  },
  "aaaaaaaa-0005-4000-8000-000000000002",
  "google-gmail-read"
);

const gmailDraft = publish(
  {
    toolId: GOOGLE_TOOL_IDS.gmailDraft,
    toolVersion: TOOL_VERSION,
    action: GOOGLE_TOOL_IDS.gmailDraft,
    inputSchema: gmailDraftInputSchema,
    outputSchema: gmailDraftOutputSchema,
    riskClass: "medium",
    mutating: true,
    dataClasses: GMAIL_DATA_CLASSES,
    allowedDestinations: [GOOGLE_DESTINATION],
    // A draft is created, not sent: no auto-retry, and the effect ledger dedups crash-replays,
    // so we rely on the provider rather than a reconciliation lookup.
    idempotency: { strategy: "provider" },
    timeout: { wallClockMs: 15_000 },
    retry: { maxAttempts: 1, safeToRetry: false },
    dryRun: false,
    adapter: { kind: "integration", ref: GOOGLE_ADAPTER_REF },
  },
  "aaaaaaaa-0005-4000-8000-000000000003",
  "google-gmail-draft"
);

// --- Calendar ---------------------------------------------------------------------------------

const calendarListInputSchema = {
  type: "object",
  additionalProperties: false,
  required: [],
  properties: {
    calendarId: {
      type: "string",
      maxLength: 256,
      description: "Calendar to read. Defaults to the user's primary calendar.",
    },
    query: { type: "string", maxLength: 500, description: "Free-text event search." },
    timeMin: {
      type: "string",
      description: "RFC 3339 lower bound, e.g. 2026-01-01T00:00:00Z. Defaults to now.",
    },
    timeMax: { type: "string", description: "RFC 3339 upper bound." },
    maxResults: { type: "integer", minimum: 1, maximum: 50 },
  },
} as const;

const calendarEventSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id"],
  properties: {
    id: { type: "string" },
    summary: { type: "string" },
    start: { type: "string" },
    end: { type: "string" },
    location: { type: "string" },
    status: { type: "string" },
    htmlLink: { type: "string" },
    attendees: { type: "array", items: { type: "string" } },
  },
} as const;

const calendarListOutputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["events"],
  properties: { events: { type: "array", items: calendarEventSchema } },
} as const;

const calendarCreateInputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "start", "end"],
  properties: {
    calendarId: { type: "string", maxLength: 256 },
    summary: { type: "string", minLength: 1, maxLength: 500 },
    description: { type: "string", maxLength: 8192 },
    location: { type: "string", maxLength: 500 },
    start: {
      type: "string",
      description: "RFC 3339 dateTime (2026-03-01T14:00:00Z) or an all-day date (2026-03-01).",
    },
    end: { type: "string", description: "Same format as start." },
    attendees: {
      type: "array",
      maxItems: 50,
      uniqueItems: true,
      items: { type: "string", minLength: 3, maxLength: 320 },
      description: "Attendee email addresses.",
    },
  },
} as const;

const calendarCreateOutputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["eventId"],
  properties: {
    eventId: { type: "string" },
    htmlLink: { type: "string" },
    status: { type: "string" },
  },
} as const;

const calendarUpdateInputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["eventId"],
  properties: {
    eventId: {
      type: "string",
      minLength: 1,
      maxLength: 1024,
      description: "The event id, as returned by calendar_list_events or calendar_create_event.",
    },
    calendarId: { type: "string", maxLength: 256 },
    // Only the fields you pass are changed; omit a field to leave it as-is (a partial update).
    summary: { type: "string", minLength: 1, maxLength: 500 },
    description: { type: "string", maxLength: 8192 },
    location: { type: "string", maxLength: 500 },
    start: {
      type: "string",
      description: "RFC 3339 dateTime or an all-day date. Pass with end to move the event.",
    },
    end: { type: "string", description: "Same format as start; required when start is set." },
    attendees: {
      type: "array",
      maxItems: 50,
      uniqueItems: true,
      items: { type: "string", minLength: 3, maxLength: 320 },
      description: "Replaces the full attendee list.",
    },
  },
} as const;

const calendarDeleteInputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["eventId"],
  properties: {
    eventId: { type: "string", minLength: 1, maxLength: 1024 },
    calendarId: { type: "string", maxLength: 256 },
  },
} as const;

const calendarDeleteOutputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["eventId", "deleted"],
  properties: {
    eventId: { type: "string" },
    deleted: { type: "boolean" },
  },
} as const;

// --- Drive ------------------------------------------------------------------------------------

const driveSearchInputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["query"],
  properties: {
    query: {
      type: "string",
      minLength: 1,
      maxLength: 500,
      description:
        "Plain keywords match file name and full text. A raw Drive query is used as-is when it " +
        "contains an operator (e.g. \"name contains 'report'\" or \"mimeType='application/pdf'\").",
    },
    maxResults: { type: "integer", minimum: 1, maximum: 50 },
  },
} as const;

const driveFileSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "name"],
  properties: {
    id: { type: "string" },
    name: { type: "string" },
    mimeType: { type: "string" },
    modifiedTime: { type: "string" },
    webViewLink: { type: "string" },
  },
} as const;

const driveSearchOutputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["files"],
  properties: { files: { type: "array", items: driveFileSchema } },
} as const;

// --- Docs -------------------------------------------------------------------------------------

const docsReadInputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["documentId"],
  properties: {
    documentId: {
      type: "string",
      minLength: 1,
      maxLength: 256,
      description: "The Google Doc id (from a Drive search result or the document URL).",
    },
  },
} as const;

const docsReadOutputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["documentId", "title", "body"],
  properties: {
    documentId: { type: "string" },
    title: { type: "string" },
    body: { type: "string" },
  },
} as const;

const docsCreateInputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["title"],
  properties: {
    title: { type: "string", minLength: 1, maxLength: 500 },
    body: { type: "string", maxLength: 100_000, description: "Optional initial document text." },
  },
} as const;

const docsCreateOutputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["documentId"],
  properties: {
    documentId: { type: "string" },
    title: { type: "string" },
    documentUrl: { type: "string" },
  },
} as const;

const docsAppendInputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["documentId", "text"],
  properties: {
    documentId: { type: "string", minLength: 1, maxLength: 256 },
    text: { type: "string", minLength: 1, maxLength: 100_000, description: "Text to append." },
  },
} as const;

const docsAppendOutputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["documentId"],
  properties: { documentId: { type: "string" } },
} as const;

const calendarListEvents = publish(
  {
    toolId: GOOGLE_TOOL_IDS.calendarListEvents,
    toolVersion: TOOL_VERSION,
    action: GOOGLE_TOOL_IDS.calendarListEvents,
    inputSchema: calendarListInputSchema,
    outputSchema: calendarListOutputSchema,
    riskClass: "low",
    mutating: false,
    dataClasses: GMAIL_DATA_CLASSES,
    allowedDestinations: [GOOGLE_DESTINATION],
    idempotency: { strategy: "none" },
    timeout: { wallClockMs: 15_000 },
    retry: { maxAttempts: 3, safeToRetry: true },
    dryRun: false,
    adapter: { kind: "integration", ref: GOOGLE_ADAPTER_REF },
  },
  "aaaaaaaa-0005-4000-8000-000000000004",
  "google-calendar-list-events"
);

const calendarCreateEvent = publish(
  {
    toolId: GOOGLE_TOOL_IDS.calendarCreateEvent,
    toolVersion: TOOL_VERSION,
    action: GOOGLE_TOOL_IDS.calendarCreateEvent,
    inputSchema: calendarCreateInputSchema,
    outputSchema: calendarCreateOutputSchema,
    riskClass: "medium",
    mutating: true,
    dataClasses: GMAIL_DATA_CLASSES,
    allowedDestinations: [GOOGLE_DESTINATION],
    idempotency: { strategy: "provider" },
    timeout: { wallClockMs: 15_000 },
    retry: { maxAttempts: 1, safeToRetry: false },
    dryRun: false,
    adapter: { kind: "integration", ref: GOOGLE_ADAPTER_REF },
  },
  "aaaaaaaa-0005-4000-8000-000000000005",
  "google-calendar-create-event"
);

const calendarUpdateEvent = publish(
  {
    toolId: GOOGLE_TOOL_IDS.calendarUpdateEvent,
    toolVersion: TOOL_VERSION,
    action: GOOGLE_TOOL_IDS.calendarUpdateEvent,
    inputSchema: calendarUpdateInputSchema,
    outputSchema: calendarCreateOutputSchema,
    riskClass: "medium",
    mutating: true,
    dataClasses: GMAIL_DATA_CLASSES,
    allowedDestinations: [GOOGLE_DESTINATION],
    idempotency: { strategy: "provider" },
    timeout: { wallClockMs: 15_000 },
    retry: { maxAttempts: 1, safeToRetry: false },
    dryRun: false,
    adapter: { kind: "integration", ref: GOOGLE_ADAPTER_REF },
  },
  "aaaaaaaa-0005-4000-8000-000000000010",
  "google-calendar-update-event"
);

const calendarDeleteEvent = publish(
  {
    toolId: GOOGLE_TOOL_IDS.calendarDeleteEvent,
    toolVersion: TOOL_VERSION,
    action: GOOGLE_TOOL_IDS.calendarDeleteEvent,
    inputSchema: calendarDeleteInputSchema,
    outputSchema: calendarDeleteOutputSchema,
    riskClass: "medium",
    mutating: true,
    dataClasses: GMAIL_DATA_CLASSES,
    allowedDestinations: [GOOGLE_DESTINATION],
    // Deleting is naturally idempotent — a second delete is a provider 404 the ledger absorbs.
    idempotency: { strategy: "provider" },
    timeout: { wallClockMs: 15_000 },
    retry: { maxAttempts: 1, safeToRetry: false },
    dryRun: false,
    adapter: { kind: "integration", ref: GOOGLE_ADAPTER_REF },
  },
  "aaaaaaaa-0005-4000-8000-000000000011",
  "google-calendar-delete-event"
);

const driveSearch = publish(
  {
    toolId: GOOGLE_TOOL_IDS.driveSearch,
    toolVersion: TOOL_VERSION,
    action: GOOGLE_TOOL_IDS.driveSearch,
    inputSchema: driveSearchInputSchema,
    outputSchema: driveSearchOutputSchema,
    riskClass: "low",
    mutating: false,
    dataClasses: GMAIL_DATA_CLASSES,
    allowedDestinations: [GOOGLE_DESTINATION],
    idempotency: { strategy: "none" },
    timeout: { wallClockMs: 15_000 },
    retry: { maxAttempts: 3, safeToRetry: true },
    dryRun: false,
    adapter: { kind: "integration", ref: GOOGLE_ADAPTER_REF },
  },
  "aaaaaaaa-0005-4000-8000-000000000006",
  "google-drive-search"
);

const docsRead = publish(
  {
    toolId: GOOGLE_TOOL_IDS.docsRead,
    toolVersion: TOOL_VERSION,
    action: GOOGLE_TOOL_IDS.docsRead,
    inputSchema: docsReadInputSchema,
    outputSchema: docsReadOutputSchema,
    riskClass: "low",
    mutating: false,
    dataClasses: GMAIL_DATA_CLASSES,
    allowedDestinations: [GOOGLE_DESTINATION],
    idempotency: { strategy: "none" },
    timeout: { wallClockMs: 15_000 },
    retry: { maxAttempts: 3, safeToRetry: true },
    dryRun: false,
    adapter: { kind: "integration", ref: GOOGLE_ADAPTER_REF },
  },
  "aaaaaaaa-0005-4000-8000-000000000007",
  "google-docs-read"
);

const docsCreate = publish(
  {
    toolId: GOOGLE_TOOL_IDS.docsCreate,
    toolVersion: TOOL_VERSION,
    action: GOOGLE_TOOL_IDS.docsCreate,
    inputSchema: docsCreateInputSchema,
    outputSchema: docsCreateOutputSchema,
    riskClass: "medium",
    mutating: true,
    dataClasses: GMAIL_DATA_CLASSES,
    allowedDestinations: [GOOGLE_DESTINATION],
    idempotency: { strategy: "provider" },
    timeout: { wallClockMs: 15_000 },
    retry: { maxAttempts: 1, safeToRetry: false },
    dryRun: false,
    adapter: { kind: "integration", ref: GOOGLE_ADAPTER_REF },
  },
  "aaaaaaaa-0005-4000-8000-000000000008",
  "google-docs-create"
);

const docsAppend = publish(
  {
    toolId: GOOGLE_TOOL_IDS.docsAppend,
    toolVersion: TOOL_VERSION,
    action: GOOGLE_TOOL_IDS.docsAppend,
    inputSchema: docsAppendInputSchema,
    outputSchema: docsAppendOutputSchema,
    riskClass: "medium",
    mutating: true,
    dataClasses: GMAIL_DATA_CLASSES,
    allowedDestinations: [GOOGLE_DESTINATION],
    idempotency: { strategy: "provider" },
    timeout: { wallClockMs: 15_000 },
    retry: { maxAttempts: 1, safeToRetry: false },
    dryRun: false,
    adapter: { kind: "integration", ref: GOOGLE_ADAPTER_REF },
  },
  "aaaaaaaa-0005-4000-8000-000000000009",
  "google-docs-append"
);

export const GOOGLE_TOOL_CONTRACTS: readonly ToolContractDefinition[] = [
  gmailSearch,
  gmailRead,
  gmailDraft,
  calendarListEvents,
  calendarCreateEvent,
  calendarUpdateEvent,
  calendarDeleteEvent,
  driveSearch,
  docsRead,
  docsCreate,
  docsAppend,
];
