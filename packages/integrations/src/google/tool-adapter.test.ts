import type { ToolAdapterRequest, ToolIntent } from "@tulipfarm/tool-broker";
import { describe, expect, it } from "vitest";
import type { IntegrationHttpPort, IntegrationHttpRequest } from "../http";
import { GOOGLE_TOOL_IDS } from "./contracts";
import { GoogleToolAdapter } from "./tool-adapter";

const CREDENTIAL = "google-token";

function docsReadRequest(): ToolAdapterRequest {
  const intent: ToolIntent = {
    intentId: "11111111-1111-4111-8111-111111111111",
    businessId: "biz-1",
    runId: "run-1",
    stateId: "state-1",
    toolId: GOOGLE_TOOL_IDS.docsRead,
    toolVersion: "1.0.0",
    action: GOOGLE_TOOL_IDS.docsRead,
    targetRefs: [],
    arguments: { documentId: "doc-1" },
    credentialRef: "google-token",
    idempotencyKey: "22222222-2222-4222-8222-222222222222",
  };
  return { intent, idempotencyKey: intent.idempotencyKey, attempt: 1 };
}

function adapter(document: unknown): GoogleToolAdapter {
  const http: IntegrationHttpPort = {
    async send(request: IntegrationHttpRequest, credential: string) {
      expect(request).toMatchObject({ method: "GET", path: "/documents/doc-1" });
      expect(credential).toBe(CREDENTIAL);
      return { status: 200, headers: {}, body: document };
    },
  };
  return new GoogleToolAdapter({ http: () => http });
}

function paragraph(text: string) {
  return { paragraph: { elements: [{ textRun: { content: text } }] } };
}

describe("GoogleToolAdapter Docs reading", () => {
  it("extracts a table-only document with nested table content", async () => {
    const document = {
      documentId: "doc-1",
      title: "Table",
      body: {
        content: [
          {
            table: {
              tableRows: [
                {
                  tableCells: [
                    { content: [paragraph("Name\n")] },
                    { content: [paragraph("Details\n")] },
                  ],
                },
                {
                  tableCells: [
                    { content: [paragraph("TulipFarm\n")] },
                    {
                      content: [
                        {
                          table: {
                            tableRows: [
                              {
                                tableCells: [
                                  { content: [paragraph("Self-hosted\n")] },
                                  { content: [paragraph("Agent control panel\n")] },
                                ],
                              },
                            ],
                          },
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          },
        ],
      },
    };

    await expect(adapter(document).dispatch(docsReadRequest(), CREDENTIAL)).resolves.toEqual({
      documentId: "doc-1",
      title: "Table",
      body: "Name\tDetails\nTulipFarm\tSelf-hosted\tAgent control panel\n",
    });
  });

  it("keeps readable boundaries across paragraphs, tables, and table-of-contents content", async () => {
    const document = {
      documentId: "doc-1",
      title: "Mixed",
      body: {
        content: [
          paragraph("Intro\n"),
          {
            table: {
              tableRows: [
                {
                  tableCells: [{ content: [paragraph("A\n")] }, { content: [paragraph("B\n")] }],
                },
              ],
            },
          },
          { tableOfContents: { content: [paragraph("Contents entry\n")] } },
          paragraph("After\n"),
        ],
      },
    };

    await expect(adapter(document).dispatch(docsReadRequest(), CREDENTIAL)).resolves.toEqual({
      documentId: "doc-1",
      title: "Mixed",
      body: "Intro\nA\tB\nContents entry\nAfter\n",
    });
  });
});
