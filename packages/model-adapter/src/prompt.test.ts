import type { ResolvedAttachment } from "@tulipfarm/agent-runtime";
import { createModel } from "@tulipfarm/llm";
import { textContent } from "@tulipfarm/schema";
import { generateText } from "ai";
import { describe, expect, it, vi } from "vitest";
import {
  assertModelOutputComplete,
  splitPrompt,
  stablePrefixChars,
  toToolSet,
  withCacheBreakpoint,
} from "./prompt";

describe("toToolSet", () => {
  const definitions = [
    {
      name: "add_issue_comment",
      description: "Add a comment or reaction.",
      inputSchema: {
        type: "object",
        properties: {
          owner: { type: "string" },
          repo: { type: "string" },
          issue_number: { type: "integer", minimum: 1 },
          body: { type: "string" },
          comment_id: { type: "integer", minimum: 1 },
          reaction: { type: "string", enum: ["+1", "-1", "heart"] },
        },
        required: ["owner", "repo", "issue_number"],
      },
    },
    {
      name: "issue_write",
      inputSchema: {
        type: "object",
        properties: {
          method: { type: "string", enum: ["create", "update"] },
          owner: { type: "string" },
          repo: { type: "string" },
          title: { type: "string" },
          body: { type: "string" },
          issue_number: { type: "integer", minimum: 1 },
        },
        required: ["method", "owner", "repo"],
      },
    },
    {
      name: "save_draft",
      description: "Save an authored draft.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          title: { type: "string" },
          summary: { type: ["string", "null"] },
          metadata: {
            type: "object",
            properties: {
              source: { type: "string" },
              note: { type: ["string", "null"] },
              labels: { type: "array", items: { type: "string" } },
            },
            required: ["source"],
          },
          sections: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                text: { type: "string" },
                caption: { type: "string" },
              },
              required: ["text"],
            },
          },
        },
        required: ["title", "summary"],
      },
    },
  ];

  it("opts out of provider strict normalization for every raw JSON-schema contract", () => {
    const tools = toToolSet(definitions);

    for (const definition of definitions) {
      const sdkTool = tools[definition.name];
      expect(sdkTool?.strict).toBe(false);
      expect(sdkTool?.description).toBe(definition.description);
      expect(sdkTool?.inputSchema).toMatchObject({ jsonSchema: definition.inputSchema });
    }
  });

  it("sends explicit strict:false and unchanged schemas through the SDK to Azure Responses", async () => {
    const originalDefinitions = structuredClone(definitions);
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      Response.json({
        id: "resp_test",
        object: "response",
        created_at: 0,
        model: "gpt-5.6-terra",
        status: "completed",
        output: [
          {
            id: "msg_test",
            type: "message",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: "Done.", annotations: [] }],
          },
        ],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      })
    );
    vi.stubGlobal("fetch", fetch);

    try {
      const model = await createModel(
        {
          provider: "azure",
          model: "gpt-5.6-terra",
          api_key_ref: "test-key",
          resource_name: "test-resource",
          base_url: "https://test-resource.openai.azure.com/openai",
        },
        { get: vi.fn().mockResolvedValue("test-key") } as unknown as Parameters<
          typeof createModel
        >[1]
      );
      const result = await generateText({
        model,
        prompt: "Describe these tools without calling them.",
        tools: toToolSet(definitions),
        maxRetries: 0,
      });

      expect(result.text).toBe("Done.");
      expect(fetch).toHaveBeenCalledTimes(1);
      const [url, init] = fetch.mock.calls[0] ?? [];
      expect(String(url)).toContain("/responses");
      expect(init?.method).toBe("POST");
      expect(typeof init?.body).toBe("string");
      const request = JSON.parse(String(init?.body));
      expect(request.tools).toEqual(
        originalDefinitions.map((definition) => ({
          type: "function",
          name: definition.name,
          ...(definition.description === undefined ? {} : { description: definition.description }),
          parameters: definition.inputSchema,
          strict: false,
        }))
      );
      expect(definitions).toEqual(originalDefinitions);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

const png: ResolvedAttachment = {
  fileId: "file-1",
  mediaType: "image/png",
  name: "dashboard.png",
  data: new Uint8Array([1, 2, 3]),
};

const pdf: ResolvedAttachment = {
  fileId: "file-2",
  mediaType: "application/pdf",
  name: "invoice.pdf",
  data: new Uint8Array([4, 5, 6]),
};

describe("PDFs retain provider-native vision", () => {
  it.each([undefined, "# Warranty\n\n47 days."])(
    "sends original PDF bytes whether extracted text is %s",
    (text) => {
      const before = pdf.data.slice();
      const file: ResolvedAttachment = {
        ...pdf,
        text,
        visual: { kind: "pdf", pages: [{ width: 1224, height: 1584 }] },
      };
      const projected = splitPrompt([{ role: "user", content: [filePart(file)] }], [file]);
      expect(projected.messages).toEqual([
        {
          role: "user",
          content: [
            { type: "file", data: before, mediaType: "application/pdf", filename: file.name },
          ],
        },
      ]);
      expect(file.data).toEqual(before);
      expect(projected.attached).toEqual([file.fileId]);
    }
  );
});

describe("assertModelOutputComplete", () => {
  const usage = { inputTokens: 11, outputTokens: 4 };

  it("fails with billed usage when the SDK says the token ceiling cut generation", () => {
    expect(() =>
      assertModelOutputComplete({
        finishReason: "length",
        rawFinishReason: "max_tokens",
        usage,
        modelId: "model-1",
      })
    ).toThrowError(
      expect.objectContaining({
        name: "ModelInvocationError",
        reason: "model_error",
        usage,
        modelId: "model-1",
      })
    );
  });

  it("does not reject unrelated finish reasons without a failure signal", () => {
    for (const reason of ["stop", "content-filter", "tool-calls", "error", "other"] as const) {
      expect(() => assertModelOutputComplete({ finishReason: reason, usage })).not.toThrow();
    }
    expect(() => assertModelOutputComplete({ finishReason: undefined, usage })).not.toThrow();
  });
});

function filePart(file: ResolvedAttachment) {
  return { type: "file", fileId: file.fileId, mediaType: file.mediaType, name: file.name } as const;
}

describe("splitPrompt — text only", () => {
  it("keeps a text-only user message a plain string, so no prompt byte moves", () => {
    const { messages } = splitPrompt([{ role: "user", content: textContent("hello") }]);

    expect(messages).toEqual([{ role: "user", content: "hello" }]);
  });

  it("separates the system instruction from the conversation", () => {
    const { instructions, messages } = splitPrompt([
      { role: "system", content: textContent("be brief") },
      { role: "user", content: textContent("hi") },
    ]);

    expect(instructions).toEqual([{ role: "system", content: "be brief" }]);
    expect(messages).toEqual([{ role: "user", content: "hi" }]);
  });
});

describe("splitPrompt — attached files", () => {
  it("sends an attached image as an image part rather than dropping it", () => {
    const { messages } = splitPrompt(
      [{ role: "user", content: [{ type: "text", text: "what is wrong?" }, filePart(png)] }],
      [png]
    );

    expect(messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "what is wrong?" },
          { type: "image", image: png.data, mediaType: "image/png" },
        ],
      },
    ]);
  });

  it("sends a PDF as a file part, which is a different provider block from an image", () => {
    const { messages } = splitPrompt([{ role: "user", content: [filePart(pdf)] }], [pdf]);

    expect(messages).toEqual([
      {
        role: "user",
        content: [
          { type: "file", data: pdf.data, mediaType: "application/pdf", filename: "invoice.pdf" },
        ],
      },
    ]);
  });

  it("sends a spreadsheet as its extracted text, because no provider takes one as a file", () => {
    // A CSV or an .xlsx offered as a binary file part comes back as
    // `'file part media type text/csv' functionality not supported`, which reaches the person as a
    // bare model error. The text was already extracted upstream; sending it is what makes the
    // attachment work at all.
    const csv: ResolvedAttachment = {
      fileId: "file-4",
      mediaType: "text/csv",
      name: "orders.csv",
      data: new Uint8Array([7, 8, 9]),
      text: "region,revenue\nPune,4200",
    };

    const { messages } = splitPrompt([{ role: "user", content: [filePart(csv)] }], [csv]);

    expect(messages[0]?.content).toEqual([
      { type: "text", text: "orders.csv:\n\nregion,revenue\nPune,4200" },
    ]);
  });

  it("never emits an Office binary part when extraction did not yield text", () => {
    const document: ResolvedAttachment = {
      fileId: "docx-1",
      mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      name: "broken.docx",
      data: new Uint8Array([1, 2, 3]),
    };
    expect(() =>
      splitPrompt([{ role: "user", content: [filePart(document)] }], [document])
    ).toThrow("Office File requires extracted text");
    const extracted = { ...document, text: "Approval expires after 47 days." };
    expect(
      splitPrompt([{ role: "user", content: [filePart(extracted)] }], [extracted]).messages[0]
        ?.content
    ).toEqual([{ type: "text", text: "broken.docx:\n\nApproval expires after 47 days." }]);
  });

  it("still sends a PDF as a file part even though its text was extracted", () => {
    // A PDF is the one document type providers read natively, and they read it better than a flat
    // text layer does — tables and column order survive.
    const withText: ResolvedAttachment = { ...pdf, text: "Invoice 12" };

    const { messages } = splitPrompt([{ role: "user", content: [filePart(withText)] }], [withText]);

    expect(messages[0]?.content).toEqual([
      { type: "file", data: pdf.data, mediaType: "application/pdf", filename: "invoice.pdf" },
    ]);
  });

  it("falls back to a file part when a document yielded no text", () => {
    const scan: ResolvedAttachment = {
      fileId: "file-5",
      mediaType: "text/csv",
      name: "empty.csv",
      data: new Uint8Array([1]),
    };

    const { messages } = splitPrompt([{ role: "user", content: [filePart(scan)] }], [scan]);

    expect(messages[0]?.content).toEqual([
      { type: "file", data: scan.data, mediaType: "text/csv", filename: "empty.csv" },
    ]);
  });

  it("carries several images from one message, in the order they were attached", () => {
    const second: ResolvedAttachment = { ...png, fileId: "file-3", name: "second.png" };
    const { messages } = splitPrompt(
      [{ role: "user", content: [filePart(png), filePart(second)] }],
      [png, second]
    );

    const content = messages[0]?.content;
    expect(Array.isArray(content) && content).toHaveLength(2);
    expect(Array.isArray(content) && content.every((part) => part.type === "image")).toBe(true);
  });

  it("omits the text part when the person attached a file and typed nothing", () => {
    const { messages } = splitPrompt([{ role: "user", content: [filePart(png)] }], [png]);

    expect(messages[0]?.content).toEqual([
      { type: "image", image: png.data, mediaType: "image/png" },
    ]);
  });

  it("drops a file part with no resolved bytes, which is how a File reaches only its own Turn", () => {
    const { messages } = splitPrompt([
      { role: "user", content: [{ type: "text", text: "and now?" }, filePart(png)] },
    ]);

    expect(messages).toEqual([{ role: "user", content: "and now?" }]);
  });

  it("sends the file on the Turn that attached it and not on the one after", () => {
    const transcript = [
      { role: "user", content: [{ type: "text", text: "look" }, filePart(png)] },
      { role: "assistant", content: textContent("I see a chart") },
      { role: "user", content: textContent("and now?") },
    ] as const;

    // The second Turn resolves nothing: its own message named no File.
    const { messages } = splitPrompt(transcript, []);

    expect(messages.every((m) => typeof m.content === "string")).toBe(true);
  });

  it("ignores a resolved attachment no message actually names", () => {
    const { messages } = splitPrompt([{ role: "user", content: textContent("hello") }], [png]);

    expect(messages).toEqual([{ role: "user", content: "hello" }]);
  });

  it("appends only Tool-authorized reread bytes when no user File part names them", () => {
    const rereadPdf: ResolvedAttachment = { ...pdf, source: "tool" };
    const rereadImage: ResolvedAttachment = { ...png, source: "tool" };
    const unrelatedImage: ResolvedAttachment = { ...png, fileId: "unrelated" };

    const { messages, attached } = splitPrompt(
      [
        { role: "user", content: textContent("read the invoice") },
        {
          role: "assistant",
          content: textContent(
            JSON.stringify({
              toolCalls: [{ callId: "read-1", name: "file_read", arguments: { fileId: "file-2" } }],
            })
          ),
        },
        {
          role: "tool",
          content: textContent(
            JSON.stringify({ callId: "read-1", output: { attached: true, fileId: "file-2" } })
          ),
        },
      ],
      [rereadPdf, rereadImage, unrelatedImage]
    );

    expect(messages.at(-1)).toEqual({
      role: "user",
      content: [
        {
          type: "file",
          data: pdf.data,
          mediaType: "application/pdf",
          filename: "invoice.pdf",
        },
        {
          type: "file",
          data: png.data,
          mediaType: "image/png",
          filename: "dashboard.png",
        },
      ],
    });
    expect(attached).toEqual(["file-2", "file-1"]);
  });

  it("never puts bytes in a system instruction, which must stay a string", () => {
    const { instructions } = splitPrompt(
      [
        { role: "system", content: [{ type: "text", text: "be brief" }, filePart(png)] },
        { role: "user", content: textContent("hi") },
      ],
      [png]
    );

    expect(instructions).toEqual([{ role: "system", content: "be brief" }]);
  });
});

describe("attachments and prompt caching", () => {
  const instructions = [{ role: "system" as const, content: "be brief" }];
  const annotate = {
    kind: "annotate",
    providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
  } as const;

  it("measures the stable prefix from instructions and tools only, never from attachments", () => {
    // An image must not inflate the prefix measure: doing so would push a prompt that is really
    // too short over the provider minimum and pay the cache-write premium for nothing.
    expect(stablePrefixChars(instructions, undefined)).toBe("be brief".length);
  });

  it("puts the cache breakpoint on an instruction, which always precedes any attached file", () => {
    // Bytes only ever land in user messages, so they sit after the breakpoint and stay out of the
    // cached prefix. If this ever moves into `messages`, an image would be written to a
    // provider-side cache that routing never approved.
    const marked = withCacheBreakpoint(instructions, annotate);

    expect(marked).toEqual([
      { role: "system", content: "be brief", providerOptions: annotate.providerOptions },
    ]);
  });

  it("leaves a user message carrying bytes unannotated", () => {
    const { messages } = splitPrompt(
      [{ role: "user", content: [{ type: "text", text: "what is this?" }, filePart(png)] }],
      [png]
    );

    expect(messages[0]).not.toHaveProperty("providerOptions");
  });
});
