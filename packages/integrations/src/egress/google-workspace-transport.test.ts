import { readFile } from "node:fs/promises";
import { ajv, parseOimManifest } from "@tulipfarm/schema";
import type { ToolAdapterRequest } from "@tulipfarm/tool-broker";
import { describe, expect, it, vi } from "vitest";
import { FetchEgressHttp } from "./fetch-http";
import type { OimFilePort } from "./oim-files";
import { createOimFixturePaginationRuntime } from "./oim-fixture-codec";
import { OimHttpToolAdapter } from "./oim-http-adapter";
import { compileOimHttpOperations } from "./oim-http-compile";

const manifest = parseOimManifest(
  await readFile(
    new URL("../../../../integrations/google-workspace/oim.yml", import.meta.url),
    "utf8"
  )
);
const tools = compileOimHttpOperations(manifest);

function tool(id: string) {
  const compiled = tools.find((candidate) => candidate.operation.id === id);
  if (compiled === undefined) throw new Error(`missing operation ${id}`);
  return compiled;
}

function request(id: string, args: unknown): ToolAdapterRequest {
  return {
    intent: {
      intentId: "google-call",
      businessId: "business",
      runId: "run",
      stateId: "state",
      toolId: tool(id).toolId,
      toolVersion: manifest.metadata.version,
      action: tool(id).contract.spec.action,
      targetRefs: [],
      arguments: args,
      idempotencyKey: "google-call",
      filePrincipalId: "user",
    },
    idempotencyKey: "google-call",
    attempt: 1,
  };
}

function setup(
  id: string,
  responses: Response[],
  fileBytes = Buffer.from("Plan\r\n"),
  declaredSize = fileBytes.length
) {
  const sent: { url: string; headers: Headers; bytes: Buffer }[] = [];
  const content = vi.fn<OimFilePort["content"]>(async ({ fileId }) => ({
    file: { id: fileId, filename: "计划.txt", mediaType: "text/plain", sizeBytes: declaredSize },
    body: (async function* () {
      yield fileBytes;
    })(),
  }));
  const stored: { bytes: Buffer; declaredBytes: number; mediaType: string }[] = [];
  const store = vi.fn<OimFilePort["store"]>(async (input) => {
    const chunks: Uint8Array[] = [];
    for await (const chunk of input.body) chunks.push(chunk);
    const bytes = Buffer.concat(chunks);
    stored.push({ bytes, declaredBytes: input.declaredBytes, mediaType: input.claimedMediaType });
    return {
      id: "saved-file",
      filename: input.filename,
      mediaType: input.claimedMediaType,
      sizeBytes: bytes.length,
    };
  });
  const authorize = vi.fn(async () => undefined);
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    const body = init.body;
    const chunks: Uint8Array[] = [];
    if (body !== null && body !== undefined) {
      if (typeof body === "string") chunks.push(Buffer.from(body));
      else if (Symbol.asyncIterator in Object(body)) {
        for await (const chunk of body as AsyncIterable<Uint8Array>) chunks.push(chunk);
      } else throw new Error("unexpected transport body");
    }
    sent.push({ url, headers: new Headers(init.headers), bytes: Buffer.concat(chunks) });
    const response = responses.shift();
    if (response === undefined) throw new Error("unexpected request");
    return response;
  });
  const compiled = tool(id);
  const adapter = new OimHttpToolAdapter({
    binding: compiled.binding,
    pagination: compiled.pagination,
    paginationRuntime: createOimFixturePaginationRuntime(),
    http: new FetchEgressHttp({ fetch }),
    files: { content, store },
    fileReadAuthorization: { assertAuthorized: authorize },
  });
  return { adapter, sent, content, store, stored, authorize, fetch };
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
}

describe("Google Workspace production declarations", () => {
  it("opts every supported Drive file operation into Shared Drives", () => {
    for (const id of [
      "drive-list-files",
      "drive-get-file",
      "drive-create-file",
      "drive-update-file",
      "drive-download-file",
    ]) {
      expect(tools.find((tool) => tool.operation.id === id)?.binding.pinnedQuery).toMatchObject({
        supportsAllDrives: "true",
      });
    }
  });

  it("fixes corpora independently of model arguments and rejects incomplete searches", async () => {
    const id = "drive-list-shared-drive-files";
    const { adapter, sent } = setup(id, [json({ incompleteSearch: true, files: [] })]);
    await expect(
      adapter.dispatch(request(id, { driveId: "shared-drive" }), "credential")
    ).rejects.toMatchObject({ phase: "after_dispatch", code: "invalid_output" });
    const url = new URL(sent[0]?.url ?? "");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      driveId: "shared-drive",
      corpora: "drive",
      supportsAllDrives: "true",
      includeItemsFromAllDrives: "true",
    });
    expect(url.searchParams.get("fields")).toContain("incompleteSearch");
    const validate = ajv.compile(tool(id).contract.spec.inputSchema);
    expect(validate({ driveId: "shared-drive", corpora: "allDrives" })).toBe(false);
    expect(validate({})).toBe(false);
  });

  it("continues an empty Drive page with a nextPageToken and keeps credentials and corpus fixed", async () => {
    const id = "drive-list-shared-drive-files";
    const { adapter, sent } = setup(id, [
      json({ incompleteSearch: false, files: [], nextPageToken: "provider-cursor" }),
      json({ incompleteSearch: false, files: [{ id: "shared-file" }] }),
    ]);
    const first = (await adapter.dispatch(
      request(id, { driveId: "shared-drive" }),
      "credential"
    )) as { next_page_token: string };
    expect(first.next_page_token).toBeTruthy();
    await expect(
      adapter.dispatch(
        request(id, { driveId: "shared-drive", page_token: first.next_page_token }),
        "credential"
      )
    ).resolves.toMatchObject({ files: [{ id: "shared-file" }] });
    expect(new URL(sent[1]?.url ?? "").searchParams.get("pageToken")).toBe("provider-cursor");
    expect(sent[1]?.headers.get("Authorization")).toBe("Bearer credential");
  });

  it("accepts Gmail's real empty search shape without inventing an empty wire body", async () => {
    const id = "gmail-list-messages";
    const { adapter } = setup(id, [json({ resultSizeEstimate: 0 })]);
    await expect(adapter.dispatch(request(id, {}), "credential")).resolves.toEqual({
      resultSizeEstimate: 0,
    });
  });

  it("parses JSON without response headers but rejects an empty metadata response", async () => {
    const id = "drive-get-file";
    const { adapter } = setup(id, [
      new Response(Buffer.from('{"id":"file-a","name":"Plan"}')),
      new Response(null, { status: 200 }),
    ]);
    await expect(
      adapter.dispatch(request(id, { file_id: "file-a" }), "credential")
    ).resolves.toMatchObject({ id: "file-a", name: "Plan" });
    await expect(
      adapter.dispatch(request(id, { file_id: "file-a" }), "credential")
    ).rejects.toMatchObject({ phase: "after_dispatch", code: "invalid_output" });
  });

  it.each(["gmail-compose-send-message", "gmail-create-draft", "gmail-update-draft"])(
    "sends proper composed MIME through FetchEgressHttp for %s",
    async (id) => {
      const { adapter, sent, authorize, content } = setup(id, [
        json(
          id === "gmail-compose-send-message"
            ? { id: "provider-id" }
            : { id: "draft-id", message: { id: "provider-id" } }
        ),
      ]);
      const call = request(id, {
        draft_id: "draft123",
        body: {
          to: "muskan@example.com",
          cc: "team@example.com",
          bcc: "archive@example.com",
          subject: "计划 — review",
          text: "计划\nReview",
          html: "<p>计划</p>",
          attachments: ["file-a"],
        },
      });
      await adapter.dispatch(call, "credential");
      expect(authorize).toHaveBeenCalledWith({ request: call, fileIds: ["file-a"] });
      expect(content).toHaveBeenCalledWith({
        businessId: "business",
        principalId: "user",
        fileId: "file-a",
      });
      expect(authorize.mock.invocationCallOrder[0]).toBeLessThan(
        content.mock.invocationCallOrder[0] ?? 0
      );
      expect(sent[0]?.headers.get("content-type")).toBe("application/json");
      const body = JSON.parse(sent[0]?.bytes.toString() ?? "{}");
      const raw = id === "gmail-compose-send-message" ? body.raw : body.message.raw;
      expect(raw).toMatch(/^[A-Za-z0-9_-]+$/);
      const mime = Buffer.from(raw, "base64url").toString();
      expect(mime).toContain("To: muskan@example.com\r\n");
      expect(mime).toContain("Subject: =?UTF-8?B?");
      expect(mime).toContain("multipart/mixed");
      expect(mime).toContain("multipart/alternative");
      expect(mime).toContain('Content-Type: text/html; charset="UTF-8"');
      expect(mime).toContain(Buffer.from("计划\r\nReview").toString("base64"));
      expect(mime).toContain("filename*=UTF-8''%E8%AE%A1%E5%88%92.txt");
      expect(mime).toContain("UGxhbg0K");
      expect(mime).not.toContain("file-a");
      expect(mime.split("\r\n").every((line) => Buffer.byteLength(line) <= 998)).toBe(true);
    }
  );

  it.each([{ text: "" }, { html: "<p>Hello</p>" }])(
    "supports a single body alternative %j",
    async (part) => {
      const id = "gmail-compose-send-message";
      const { adapter, sent } = setup(id, [json({ id: "sent" })]);
      await adapter.dispatch(
        request(id, { body: { to: "muskan@example.com", subject: "", ...part } }),
        "credential"
      );
      const mime = Buffer.from(
        JSON.parse(sent[0]?.bytes.toString() ?? "{}").raw,
        "base64url"
      ).toString();
      expect(mime).not.toContain("multipart/");
      expect(mime).toContain("Content-Transfer-Encoding: base64");
    }
  );

  it("refuses header injection before transport", async () => {
    const id = "gmail-compose-send-message";
    const { adapter, fetch } = setup(id, []);
    await expect(
      adapter.dispatch(
        request(id, {
          body: { to: "muskan@example.com\r\nBcc: other@example.com", subject: "plan", text: "" },
        }),
        "credential"
      )
    ).rejects.toMatchObject({ phase: "before_dispatch", code: "invalid_arguments" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps the user's File ACL separate from the Run authorization gate", async () => {
    const id = "gmail-create-draft";
    const { adapter, content, authorize, fetch } = setup(id, []);
    content.mockRejectedValueOnce(new Error("not shared with this user"));
    await expect(
      adapter.dispatch(
        request(id, {
          body: {
            to: "muskan@example.com",
            subject: "plan",
            text: "",
            attachments: ["file-a"],
          },
        }),
        "credential"
      )
    ).rejects.toMatchObject({ code: "file_access_denied", phase: "before_dispatch" });
    expect(authorize).toHaveBeenCalledOnce();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("fails closed if a MIME File-read authorizer is absent", async () => {
    const id = "gmail-create-draft";
    const content = vi.fn<OimFilePort["content"]>();
    const fetch = vi.fn(async () => json({}));
    const adapter = new OimHttpToolAdapter({
      binding: tool(id).binding,
      http: new FetchEgressHttp({ fetch }),
      files: { content, store: vi.fn() },
    });
    await expect(
      adapter.dispatch(
        request(id, {
          body: {
            to: "muskan@example.com",
            subject: "plan",
            text: "",
            attachments: ["file-a"],
          },
        }),
        "credential"
      )
    ).rejects.toMatchObject({ code: "file_authorization_missing", phase: "before_dispatch" });
    expect(content).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["gmail-compose-send-message", "drive-upload-file"])(
    "denies unauthorized File reads before any network or content access for %s",
    async (id) => {
      const { adapter, authorize, content, fetch } = setup(id, []);
      authorize.mockRejectedValueOnce(new Error("denied"));
      const body =
        id === "drive-upload-file"
          ? { metadata: { name: "plan.txt" }, fileId: "file-a" }
          : { to: "muskan@example.com", subject: "plan", text: "", attachments: ["file-a"] };
      await expect(adapter.dispatch(request(id, { body }), "credential")).rejects.toMatchObject({
        code: "file_authorization_denied",
        phase: "before_dispatch",
      });
      expect(content).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    }
  );

  it("uploads Drive bytes as multipart/related, not form-data or a JSON File ID", async () => {
    const id = "drive-upload-file";
    const { adapter, sent } = setup(id, [json({ id: "shared-file" })]);
    await adapter.dispatch(
      request(id, {
        body: { metadata: { name: "plan.txt", parents: ["shared-folder"] }, fileId: "file-a" },
      }),
      "credential"
    );
    expect(sent[0]?.headers.get("content-type")).toMatch(
      /^multipart\/related; boundary=tulipfarm-/
    );
    const bytes = sent[0]?.bytes.toString() ?? "";
    expect(bytes).toContain(
      'Content-Type: application/json\r\n\r\n{"name":"plan.txt","parents":["shared-folder"]}'
    );
    expect(bytes).toContain("Content-Type: text/plain\r\n\r\nPlan\r\n");
    expect(bytes).not.toContain("Content-Disposition: form-data");
    expect(bytes).not.toContain("file-a");
    expect(new URL(sent[0]?.url ?? "").searchParams.get("supportsAllDrives")).toBe("true");
    expect(new URL(sent[0]?.url ?? "").searchParams.get("uploadType")).toBe("multipart");
  });

  it("uploads an empty File without converting it into missing metadata or no HTTP body", async () => {
    const id = "drive-upload-file";
    const { adapter, sent } = setup(id, [json({ id: "empty-file", size: "0" })], Buffer.alloc(0));
    await adapter.dispatch(
      request(id, { body: { metadata: { name: "empty.txt" }, fileId: "file-empty" } }),
      "credential"
    );
    expect(sent[0]?.bytes.toString()).toContain("Content-Type: text/plain\r\n\r\n\r\n--tulipfarm-");
  });

  it("refuses an inconsistent File size before upload", async () => {
    const id = "drive-upload-file";
    const { adapter, fetch } = setup(id, [], Buffer.from("Plan"), 1);
    await expect(
      adapter.dispatch(
        request(id, { body: { metadata: { name: "plan.txt" }, fileId: "file-a" } }),
        "credential"
      )
    ).rejects.toMatchObject({ code: "file_size_mismatch", phase: "before_dispatch" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("sanitizes a failed File stream before any provider dispatch", async () => {
    const id = "drive-upload-file";
    const { adapter, content, fetch } = setup(id, []);
    content.mockResolvedValueOnce({
      file: { id: "file-a", filename: "plan.txt", mediaType: "text/plain", sizeBytes: 4 },
      body: (async function* () {
        yield Buffer.from("Pl");
        throw new Error("private storage failure");
      })(),
    });
    await expect(
      adapter.dispatch(
        request(id, { body: { metadata: { name: "plan.txt" }, fileId: "file-a" } }),
        "credential"
      )
    ).rejects.toMatchObject({
      code: "file_read_failed",
      message: "file_read_failed",
      phase: "before_dispatch",
    });
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([0, 1])(
    "rejects large File bytes before upload, including a lying declared size %s",
    async (declaredSize) => {
      const id = "drive-upload-file";
      const { adapter, fetch } = setup(id, [], Buffer.alloc(5242881), declaredSize);
      await expect(
        adapter.dispatch(
          request(id, { body: { metadata: { name: "large.txt" }, fileId: "large-file" } }),
          "credential"
        )
      ).rejects.toMatchObject({ code: "request_too_large", phase: "before_dispatch" });
      expect(fetch).not.toHaveBeenCalled();
    }
  );

  it("bounds the final base64url JSON envelope, not only attachment input bytes", async () => {
    const id = "gmail-compose-send-message";
    const { adapter, fetch } = setup(id, [], Buffer.alloc(7 * 1024 * 1024));
    await expect(
      adapter.dispatch(
        request(id, {
          body: { to: "muskan@example.com", subject: "plan", text: "", attachments: ["file-a"] },
        }),
        "credential"
      )
    ).rejects.toMatchObject({ code: "request_too_large", phase: "before_dispatch" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["drive-download-file", "drive-export-file"])(
    "stores bounded binary %s responses with mixed-case headers and no content length",
    async (id) => {
      const { adapter, stored, store } = setup(id, [
        new Response(Buffer.from("Plan\n"), {
          headers: {
            "Content-Type": "text/plain; charset=UTF-8",
            "Content-Disposition": 'attachment; filename="plan.txt"',
          },
        }),
      ]);
      await expect(
        adapter.dispatch(
          request(id, { file_id: "native-id", mimeType: "text/plain" }),
          "credential"
        )
      ).resolves.toMatchObject({
        fileId: "saved-file",
        summary: {
          filename: "plan.txt",
          mediaType: "text/plain",
          sizeBytes: 5,
          truncated: false,
        },
      });
      expect(store).toHaveBeenCalledWith(
        expect.objectContaining({ businessId: "business", ownerPrincipalId: "user" })
      );
      expect(stored[0]).toEqual({
        bytes: Buffer.from("Plan\n"),
        declaredBytes: 5,
        mediaType: "text/plain",
      });
    }
  );

  it("handles a zero-byte blob response with a real empty HTTP body", async () => {
    const id = "drive-download-file";
    const { adapter, stored } = setup(id, [
      new Response(null, {
        status: 200,
        headers: { "Content-Type": "text/plain", "Content-Length": "0" },
      }),
    ]);
    await adapter.dispatch(request(id, { file_id: "empty-file" }), "credential");
    expect(stored[0]?.bytes.length).toBe(0);
  });

  it.each([true, false])(
    "rejects oversized download before File storage (length declared: %s)",
    async (declared) => {
      const id = "drive-download-file";
      const { adapter, store } = setup(id, [
        new Response(new Uint8Array(10485761), {
          headers: {
            "Content-Type": "application/octet-stream",
            ...(declared ? { "Content-Length": "10485761" } : {}),
          },
        }),
      ]);
      await expect(
        adapter.dispatch(request(id, { file_id: "large-file" }), "credential")
      ).rejects.toMatchObject({
        phase: "before_dispatch",
        code: "provider_error",
        retryable: false,
      });
      expect(store).not.toHaveBeenCalled();
    }
  );

  it("reads real calendar discovery and event response shapes", async () => {
    const discovery = setup("calendar-list-calendars", [
      json({
        items: [{ id: "muskan@example.com", summary: "Muskan Vijayvargiya", accessRole: "owner" }],
      }),
    ]);
    await expect(
      discovery.adapter.dispatch(request("calendar-list-calendars", {}), "credential")
    ).resolves.toMatchObject({ items: [{ summary: "Muskan Vijayvargiya", accessRole: "owner" }] });
    const event = setup("calendar-get-event", [
      json({
        id: "event",
        summary: "Review",
        start: { date: "2026-09-18" },
        end: { date: "2026-09-19" },
        status: "confirmed",
      }),
    ]);
    await expect(
      event.adapter.dispatch(
        request("calendar-get-event", { calendar_id: "muskan@example.com", event_id: "event" }),
        "credential"
      )
    ).resolves.toMatchObject({ summary: "Review", start: { date: "2026-09-18" } });
    expect(event.sent[0]?.url).toContain("muskan%40example.com");
  });
});
