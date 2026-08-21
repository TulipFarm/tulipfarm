import type { ToolAdapter, ToolAdapterRequest } from "@tulipfarm/tool-broker";
import { AdapterDispatchError } from "@tulipfarm/tool-broker";
import { classifyHttpFailure, type IntegrationHttpMethod, type IntegrationHttpPort } from "../http";
import { GOOGLE_TOOL_IDS, type GoogleService, type GoogleToolId } from "./contracts";
import { encodeGmailRaw } from "./mime";

/** Dispatches every Google chat Tool, routing each to its service host with a leased token. */

/** Resolves the HTTP port for one Google service; one login, four API hosts. */
export type GooglePortResolver = (service: GoogleService) => IntegrationHttpPort;

export interface GoogleToolAdapterDeps {
  readonly http: GooglePortResolver;
}

interface GoogleHeader {
  readonly name: string;
  readonly value: string;
}

interface GmailPayload {
  readonly mimeType?: string;
  readonly headers?: readonly GoogleHeader[];
  readonly body?: { readonly data?: string };
  readonly parts?: readonly GmailPayload[];
}

interface GmailMessage {
  readonly id?: string;
  readonly threadId?: string;
  readonly snippet?: string;
  readonly payload?: GmailPayload;
}

const DEFAULT_SEARCH_RESULTS = 10;
const MAX_SEARCH_RESULTS = 25;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const DRIVE_QUERY_OPERATOR = /\bcontains\b|=|mimeType|modifiedTime|trashed|parents|fullText/i;

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function requireString(source: Record<string, unknown>, key: string): string {
  const value = source[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new AdapterDispatchError("before_dispatch", "invalid_arguments", false);
  }
  return value;
}

function optionalString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function boundedResults(value: unknown, fallback: number, max: number): number {
  const requested = typeof value === "number" ? value : fallback;
  return Math.min(Math.max(Math.trunc(requested), 1), max);
}

function decodeBase64Url(value: string): string {
  return Buffer.from(value, "base64url").toString("utf8");
}

function headerValue(payload: GmailPayload | undefined, name: string): string | undefined {
  const target = name.toLowerCase();
  return payload?.headers?.find((header) => header.name.toLowerCase() === target)?.value;
}

/** Depth-first search for the first `text/plain` part; falls back to the top-level body. */
function extractPlainTextBody(payload: GmailPayload | undefined): string {
  if (payload === undefined) return "";
  if ((payload.mimeType ?? "").startsWith("text/plain") && payload.body?.data !== undefined) {
    return decodeBase64Url(payload.body.data);
  }
  for (const part of payload.parts ?? []) {
    const found = extractPlainTextBody(part);
    if (found.length > 0) return found;
  }
  if (payload.parts === undefined && payload.body?.data !== undefined) {
    return decodeBase64Url(payload.body.data);
  }
  return "";
}

function summarizeHeaders(message: GmailMessage): {
  from?: string;
  to?: string;
  subject?: string;
  date?: string;
} {
  const pick = (name: string) => {
    const value = headerValue(message.payload, name);
    return value === undefined ? {} : { [name.toLowerCase()]: value };
  };
  return { ...pick("From"), ...pick("To"), ...pick("Subject"), ...pick("Date") };
}

function calendarTime(value: string): { date: string } | { dateTime: string } {
  return DATE_ONLY.test(value) ? { date: value } : { dateTime: value };
}

function calendarBound(slot: unknown): string | undefined {
  const record = asRecord(slot);
  const dateTime = record.dateTime;
  const date = record.date;
  if (typeof dateTime === "string") return dateTime;
  if (typeof date === "string") return date;
  return undefined;
}

function driveQuery(query: string): string {
  if (DRIVE_QUERY_OPERATOR.test(query)) return query;
  const escaped = query.replace(/'/g, "\\'");
  return `fullText contains '${escaped}' or name contains '${escaped}'`;
}

/** Flattens a Docs `body.content` tree into its text runs. */
function extractDocumentText(document: Record<string, unknown>): string {
  const body = asRecord(document.body);
  const content = Array.isArray(body.content) ? body.content : [];
  let text = "";
  for (const element of content) {
    const paragraph = asRecord(asRecord(element).paragraph);
    const elements = Array.isArray(paragraph.elements) ? paragraph.elements : [];
    for (const run of elements) {
      const textRun = asRecord(asRecord(run).textRun);
      if (typeof textRun.content === "string") text += textRun.content;
    }
  }
  return text;
}

export class GoogleToolAdapter implements ToolAdapter {
  readonly kind = "integration" as const;

  constructor(private readonly deps: GoogleToolAdapterDeps) {}

  async dispatch(request: ToolAdapterRequest, credential?: string): Promise<unknown> {
    if (credential === undefined) {
      throw new AdapterDispatchError("before_dispatch", "credential_missing", false);
    }
    const toolId = request.intent.toolId as GoogleToolId;
    const args = asRecord(request.intent.arguments);

    switch (toolId) {
      case GOOGLE_TOOL_IDS.gmailSearch:
        return this.searchMessages(args, credential);
      case GOOGLE_TOOL_IDS.gmailRead:
        return this.readMessage(args, credential);
      case GOOGLE_TOOL_IDS.gmailDraft:
        return this.createDraft(args, credential);
      case GOOGLE_TOOL_IDS.calendarListEvents:
        return this.listEvents(args, credential);
      case GOOGLE_TOOL_IDS.calendarCreateEvent:
        return this.createEvent(args, credential);
      case GOOGLE_TOOL_IDS.calendarUpdateEvent:
        return this.updateEvent(args, credential);
      case GOOGLE_TOOL_IDS.calendarDeleteEvent:
        return this.deleteEvent(args, credential);
      case GOOGLE_TOOL_IDS.driveSearch:
        return this.searchDrive(args, credential);
      case GOOGLE_TOOL_IDS.docsRead:
        return this.readDocument(args, credential);
      case GOOGLE_TOOL_IDS.docsCreate:
        return this.createDocument(args, credential);
      case GOOGLE_TOOL_IDS.docsAppend:
        return this.appendDocument(args, credential);
      default:
        throw new AdapterDispatchError("before_dispatch", "unsupported_tool", false);
    }
  }

  // --- Gmail ----------------------------------------------------------------------------------

  private async searchMessages(
    args: Record<string, unknown>,
    credential: string
  ): Promise<unknown> {
    const query = requireString(args, "query");
    const maxResults = boundedResults(args.maxResults, DEFAULT_SEARCH_RESULTS, MAX_SEARCH_RESULTS);

    const listed = await this.request(
      "gmail",
      {
        method: "GET",
        path: "/users/me/messages",
        query: { q: query, maxResults: String(maxResults) },
      },
      credential,
      false
    );
    const ids = asArray(asRecord(listed).messages).filter(
      (entry): entry is { id: string; threadId?: string } => typeof asRecord(entry).id === "string"
    );

    const messages = await Promise.all(
      ids.slice(0, maxResults).map(async (entry) => {
        const detail = (await this.request(
          "gmail",
          {
            method: "GET",
            path: `/users/me/messages/${encodeURIComponent(entry.id)}`,
            query: { format: "metadata" },
          },
          credential,
          false
        )) as GmailMessage;
        return {
          id: detail.id ?? entry.id,
          threadId: detail.threadId ?? entry.threadId ?? "",
          ...summarizeHeaders(detail),
          ...(detail.snippet === undefined ? {} : { snippet: detail.snippet }),
        };
      })
    );

    return { messages };
  }

  private async readMessage(args: Record<string, unknown>, credential: string): Promise<unknown> {
    const messageId = requireString(args, "messageId");
    const message = (await this.request(
      "gmail",
      {
        method: "GET",
        path: `/users/me/messages/${encodeURIComponent(messageId)}`,
        query: { format: "full" },
      },
      credential,
      false
    )) as GmailMessage;

    const cc = headerValue(message.payload, "Cc");
    return {
      id: message.id ?? messageId,
      threadId: message.threadId ?? "",
      ...summarizeHeaders(message),
      ...(cc === undefined ? {} : { cc }),
      ...(message.snippet === undefined ? {} : { snippet: message.snippet }),
      body: extractPlainTextBody(message.payload),
    };
  }

  private async createDraft(args: Record<string, unknown>, credential: string): Promise<unknown> {
    const raw = encodeGmailRaw({
      to: requireString(args, "to"),
      subject: optionalString(args, "subject") ?? "",
      body: requireString(args, "body"),
      ...(optionalString(args, "cc") === undefined ? {} : { cc: optionalString(args, "cc") }),
      ...(optionalString(args, "bcc") === undefined ? {} : { bcc: optionalString(args, "bcc") }),
    });
    const threadId = optionalString(args, "threadId");

    const body = asRecord(
      await this.request(
        "gmail",
        {
          method: "POST",
          path: "/users/me/drafts",
          body: { message: { raw, ...(threadId === undefined ? {} : { threadId }) } },
        },
        credential,
        true
      )
    );

    const draftId = body.id;
    if (typeof draftId !== "string") {
      throw new AdapterDispatchError("after_dispatch", "invalid_response", false);
    }
    const message = asRecord(body.message);
    return {
      draftId,
      ...(typeof message.id === "string" ? { messageId: message.id } : {}),
      ...(typeof message.threadId === "string" ? { threadId: message.threadId } : {}),
    };
  }

  // --- Calendar -------------------------------------------------------------------------------

  private async listEvents(args: Record<string, unknown>, credential: string): Promise<unknown> {
    const calendarId = optionalString(args, "calendarId") ?? "primary";
    const maxResults = boundedResults(args.maxResults, DEFAULT_SEARCH_RESULTS, 50);
    const query: Record<string, string> = {
      singleEvents: "true",
      orderBy: "startTime",
      maxResults: String(maxResults),
      timeMin: optionalString(args, "timeMin") ?? new Date().toISOString(),
      ...(optionalString(args, "timeMax") === undefined ? {} : { timeMax: args.timeMax as string }),
      ...(optionalString(args, "query") === undefined ? {} : { q: args.query as string }),
    };

    const response = await this.request(
      "calendar",
      { method: "GET", path: `/calendars/${encodeURIComponent(calendarId)}/events`, query },
      credential,
      false
    );
    const events = asArray(asRecord(response).items).map((item) => {
      const event = asRecord(item);
      const attendees = Array.isArray(event.attendees)
        ? event.attendees
            .map((attendee) => asRecord(attendee).email)
            .filter((email): email is string => typeof email === "string")
        : [];
      return {
        id: typeof event.id === "string" ? event.id : "",
        ...(typeof event.summary === "string" ? { summary: event.summary } : {}),
        ...(calendarBound(event.start) === undefined ? {} : { start: calendarBound(event.start) }),
        ...(calendarBound(event.end) === undefined ? {} : { end: calendarBound(event.end) }),
        ...(typeof event.location === "string" ? { location: event.location } : {}),
        ...(typeof event.status === "string" ? { status: event.status } : {}),
        ...(typeof event.htmlLink === "string" ? { htmlLink: event.htmlLink } : {}),
        ...(attendees.length === 0 ? {} : { attendees }),
      };
    });

    return { events };
  }

  private async createEvent(args: Record<string, unknown>, credential: string): Promise<unknown> {
    const calendarId = optionalString(args, "calendarId") ?? "primary";
    const attendees = Array.isArray(args.attendees)
      ? args.attendees
          .filter((email): email is string => typeof email === "string")
          .map((email) => ({ email }))
      : [];
    const body = {
      summary: requireString(args, "summary"),
      ...(optionalString(args, "description") === undefined
        ? {}
        : { description: args.description }),
      ...(optionalString(args, "location") === undefined ? {} : { location: args.location }),
      start: calendarTime(requireString(args, "start")),
      end: calendarTime(requireString(args, "end")),
      ...(attendees.length === 0 ? {} : { attendees }),
    };

    const created = asRecord(
      await this.request(
        "calendar",
        { method: "POST", path: `/calendars/${encodeURIComponent(calendarId)}/events`, body },
        credential,
        true
      )
    );
    const eventId = created.id;
    if (typeof eventId !== "string") {
      throw new AdapterDispatchError("after_dispatch", "invalid_response", false);
    }
    return {
      eventId,
      ...(typeof created.htmlLink === "string" ? { htmlLink: created.htmlLink } : {}),
      ...(typeof created.status === "string" ? { status: created.status } : {}),
    };
  }

  /** Partial update: only the fields supplied are sent, so omitted fields keep their value. */
  private async updateEvent(args: Record<string, unknown>, credential: string): Promise<unknown> {
    const calendarId = optionalString(args, "calendarId") ?? "primary";
    const eventId = requireString(args, "eventId");

    const body: Record<string, unknown> = {};
    const summary = optionalString(args, "summary");
    if (summary !== undefined) body.summary = summary;
    const description = optionalString(args, "description");
    if (description !== undefined) body.description = description;
    const location = optionalString(args, "location");
    if (location !== undefined) body.location = location;
    const start = optionalString(args, "start");
    if (start !== undefined) body.start = calendarTime(start);
    const end = optionalString(args, "end");
    if (end !== undefined) body.end = calendarTime(end);
    if (Array.isArray(args.attendees)) {
      body.attendees = args.attendees
        .filter((email): email is string => typeof email === "string")
        .map((email) => ({ email }));
    }

    const updated = asRecord(
      await this.request(
        "calendar",
        {
          method: "PATCH",
          path: `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
          body,
        },
        credential,
        true
      )
    );
    const id = updated.id;
    if (typeof id !== "string") {
      throw new AdapterDispatchError("after_dispatch", "invalid_response", false);
    }
    return {
      eventId: id,
      ...(typeof updated.htmlLink === "string" ? { htmlLink: updated.htmlLink } : {}),
      ...(typeof updated.status === "string" ? { status: updated.status } : {}),
    };
  }

  private async deleteEvent(args: Record<string, unknown>, credential: string): Promise<unknown> {
    const calendarId = optionalString(args, "calendarId") ?? "primary";
    const eventId = requireString(args, "eventId");
    // Google answers a successful delete with 204 No Content, which classifies as success.
    await this.request(
      "calendar",
      {
        method: "DELETE",
        path: `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
      },
      credential,
      true
    );
    return { eventId, deleted: true };
  }

  // --- Drive ----------------------------------------------------------------------------------

  private async searchDrive(args: Record<string, unknown>, credential: string): Promise<unknown> {
    const maxResults = boundedResults(args.maxResults, DEFAULT_SEARCH_RESULTS, 50);
    const response = await this.request(
      "drive",
      {
        method: "GET",
        path: "/files",
        query: {
          q: driveQuery(requireString(args, "query")),
          pageSize: String(maxResults),
          fields: "files(id,name,mimeType,modifiedTime,webViewLink)",
          spaces: "drive",
        },
      },
      credential,
      false
    );
    const files = asArray(asRecord(response).files).map((file) => {
      const record = asRecord(file);
      return {
        id: typeof record.id === "string" ? record.id : "",
        name: typeof record.name === "string" ? record.name : "",
        ...(typeof record.mimeType === "string" ? { mimeType: record.mimeType } : {}),
        ...(typeof record.modifiedTime === "string" ? { modifiedTime: record.modifiedTime } : {}),
        ...(typeof record.webViewLink === "string" ? { webViewLink: record.webViewLink } : {}),
      };
    });
    return { files };
  }

  // --- Docs -----------------------------------------------------------------------------------

  private async readDocument(args: Record<string, unknown>, credential: string): Promise<unknown> {
    const documentId = requireString(args, "documentId");
    const document = asRecord(
      await this.request(
        "docs",
        { method: "GET", path: `/documents/${encodeURIComponent(documentId)}` },
        credential,
        false
      )
    );
    return {
      documentId: typeof document.documentId === "string" ? document.documentId : documentId,
      title: typeof document.title === "string" ? document.title : "",
      body: extractDocumentText(document),
    };
  }

  private async createDocument(
    args: Record<string, unknown>,
    credential: string
  ): Promise<unknown> {
    const title = requireString(args, "title");
    const created = asRecord(
      await this.request(
        "docs",
        { method: "POST", path: "/documents", body: { title } },
        credential,
        true
      )
    );
    const documentId = created.documentId;
    if (typeof documentId !== "string") {
      throw new AdapterDispatchError("after_dispatch", "invalid_response", false);
    }

    const bodyText = optionalString(args, "body");
    if (bodyText !== undefined) {
      await this.request(
        "docs",
        {
          method: "POST",
          path: `/documents/${encodeURIComponent(documentId)}:batchUpdate`,
          body: { requests: [{ insertText: { location: { index: 1 }, text: bodyText } }] },
        },
        credential,
        true
      );
    }

    return {
      documentId,
      ...(typeof created.title === "string" ? { title: created.title } : {}),
      documentUrl: `https://docs.google.com/document/d/${documentId}/edit`,
    };
  }

  private async appendDocument(
    args: Record<string, unknown>,
    credential: string
  ): Promise<unknown> {
    const documentId = requireString(args, "documentId");
    const text = requireString(args, "text");
    await this.request(
      "docs",
      {
        method: "POST",
        path: `/documents/${encodeURIComponent(documentId)}:batchUpdate`,
        body: { requests: [{ insertText: { endOfSegmentLocation: {}, text } }] },
      },
      credential,
      true
    );
    return { documentId };
  }

  // --- Transport ------------------------------------------------------------------------------

  private async request(
    service: GoogleService,
    request: {
      method: IntegrationHttpMethod;
      path: string;
      query?: Record<string, string>;
      body?: unknown;
    },
    credential: string,
    mutating: boolean
  ): Promise<unknown> {
    const response = await this.deps.http(service).send(
      {
        method: request.method,
        path: request.path,
        ...(request.query === undefined ? {} : { query: request.query }),
        ...(request.body === undefined ? {} : { body: request.body }),
      },
      credential
    );
    const failure = classifyHttpFailure(response, mutating);
    if (failure !== null) {
      // Report the normalized failure code so the Tool layer maps errors predictably; Google's own
      // `error.status` string is not stable enough to branch on.
      throw new AdapterDispatchError(failure.phase, failure.code, failure.retryable);
    }
    return response.body;
  }
}
