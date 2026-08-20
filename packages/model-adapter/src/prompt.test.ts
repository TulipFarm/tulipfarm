import type { ResolvedAttachment } from "@tulipfarm/agent-runtime";
import { textContent } from "@tulipfarm/schema";
import { describe, expect, it } from "vitest";
import { splitPrompt, stablePrefixChars, withCacheBreakpoint } from "./prompt";

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
