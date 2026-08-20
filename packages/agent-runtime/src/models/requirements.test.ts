import { textContent } from "@tulipfarm/schema";
import { describe, expect, it } from "vitest";
import type { ModelInvocationRequest } from "../ports/model";
import { deriveModelRequirements, estimateContextTokens } from "./requirements";

function request(overrides: Partial<ModelInvocationRequest> = {}): ModelInvocationRequest {
  return {
    requestId: "req-1",
    modelProfileId: "balanced",
    messages: [{ role: "user", content: textContent("hello") }],
    ...overrides,
  };
}

describe("deriveModelRequirements", () => {
  it("requires tool support only when the request actually carries tools", () => {
    expect(deriveModelRequirements(request()).needsTools).toBe(false);
    expect(
      deriveModelRequirements(request({ tools: [{ name: "t", inputSchema: { type: "object" } }] }))
        .needsTools
    ).toBe(true);
  });

  it("treats an empty tool list as no tools rather than as tool use", () => {
    expect(deriveModelRequirements(request({ tools: [] })).needsTools).toBe(false);
  });

  it("requires structured output only when an output schema is declared", () => {
    expect(deriveModelRequirements(request()).needsStructuredOutput).toBe(false);
    expect(
      deriveModelRequirements(request({ outputSchema: { type: "object" } })).needsStructuredOutput
    ).toBe(true);
  });

  it("defaults to non-sensitive rather than assuming a posture the caller never stated", () => {
    expect(deriveModelRequirements(request()).sensitive).toBe(false);
  });

  it("carries governance policy through verbatim", () => {
    const derived = deriveModelRequirements(request(), {
      residency: "eu",
      dataRetention: "zero_retention",
      allowTraining: false,
      sensitive: true,
    });

    expect(derived).toMatchObject({
      residency: "eu",
      dataRetention: "zero_retention",
      allowTraining: false,
      sensitive: true,
    });
  });

  it("is deterministic — the same request derives identical requirements", () => {
    const input = request({ tools: [{ name: "t", inputSchema: { type: "object" } }] });

    expect(deriveModelRequirements(input)).toEqual(deriveModelRequirements(input));
  });
});

describe("deriveModelRequirements — input modalities", () => {
  const image = {
    fileId: "f1",
    mediaType: "image/png",
    name: "shot.png",
    data: new Uint8Array([1]),
  };
  const pdf = {
    fileId: "f2",
    mediaType: "application/pdf",
    name: "d.pdf",
    data: new Uint8Array([2]),
  };
  const filePart = (file: { fileId: string; mediaType: string; name: string }) =>
    ({ type: "file", ...file }) as const;

  it("requires only text when the turn attached nothing", () => {
    expect(deriveModelRequirements(request()).inputModalities).toEqual(["text"]);
  });

  it("requires image when the turn attached an image", () => {
    const derived = deriveModelRequirements(request({ attachments: [image] }));

    expect(derived.inputModalities).toEqual(["text", "image"]);
  });

  it("requires document when the turn attached a PDF", () => {
    const derived = deriveModelRequirements(request({ attachments: [pdf] }));

    expect(derived.inputModalities).toEqual(["text", "document"]);
  });

  it("names each modality once however many files of that kind are attached", () => {
    const derived = deriveModelRequirements(
      request({ attachments: [image, { ...image, fileId: "f3" }, pdf] })
    );

    expect(derived.inputModalities).toEqual(["text", "image", "document"]);
  });

  it("unions what the turn needs with what policy already required, never replacing it", () => {
    const derived = deriveModelRequirements(request({ attachments: [image] }), {
      inputModalities: ["text", "audio"],
    });

    expect(derived.inputModalities).toEqual(["text", "audio", "image"]);
  });

  it("keeps a policy-declared modality when the turn itself attached nothing", () => {
    const derived = deriveModelRequirements(request(), { inputModalities: ["text", "image"] });

    expect(derived.inputModalities).toEqual(["text", "image"]);
  });

  it("requires a modality for an unrecognised media type rather than passing it as text", () => {
    const derived = deriveModelRequirements(
      request({ attachments: [{ ...image, mediaType: "audio/mpeg" }] })
    );

    expect(derived.inputModalities).toEqual(["text", "audio"]);
  });

  it("does not demand vision for an earlier Turn's file part, which reaches no provider", () => {
    // The image is still named in the transcript, but nothing resolved it: this Turn sends no
    // bytes, so pinning the conversation to a vision model for good would be wrong.
    const derived = deriveModelRequirements(
      request({
        messages: [
          { role: "user", content: [{ type: "text", text: "look" }, filePart(image)] },
          { role: "user", content: textContent("and now?") },
        ],
      })
    );

    expect(derived.inputModalities).toEqual(["text"]);
  });
});

describe("estimateContextTokens", () => {
  it("grows with the transcript", () => {
    const small = estimateContextTokens(request());
    const large = estimateContextTokens(
      request({ messages: [{ role: "user", content: textContent("x".repeat(4_000)) }] })
    );

    expect(large).toBeGreaterThan(small);
  });

  it("counts tool definitions, which occupy context like any other prompt text", () => {
    const withTools = estimateContextTokens(
      request({
        tools: [{ name: "t", description: "d".repeat(400), inputSchema: { type: "object" } }],
      })
    );

    expect(withTools).toBeGreaterThan(estimateContextTokens(request()));
  });

  it("reserves headroom for the answer so a prompt that just fits is not chosen", () => {
    // Without headroom this would be ~2 tokens and any model would look adequate.
    expect(estimateContextTokens(request())).toBeGreaterThan(1_000);
  });

  it("reserves the caller's own output budget when one is declared", () => {
    expect(estimateContextTokens(request({ maxOutputTokens: 8_000 }))).toBeGreaterThan(8_000);
  });
});
