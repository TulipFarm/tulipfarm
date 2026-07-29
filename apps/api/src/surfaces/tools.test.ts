import type { SurfaceComponentDefinition } from "@tulipfarm/surface";
import { describe, expect, it } from "vitest";
import { MemorySurfaceActionStore } from "./action-store";
import { MemorySurfaceArtifactStore } from "./artifact-store";
import {
  presentationContextFor,
  surfaceCatalogFor,
  surfaceRendererRegistry,
} from "./renderer-registry";
import { presentTool, requestInputTool } from "./tools";

describe("Surface presentation Tool schema", () => {
  it("teaches the model the exact discriminated component shape", () => {
    const recordTable = {
      name: "RecordTable",
      version: "1.0",
      description: "Records in shared columns.",
      propsSchema: {
        type: "object",
        required: ["columns", "records"],
        properties: {
          columns: { type: "array", items: { type: "string" } },
          records: { type: "array", items: { type: "object" } },
        },
      },
      events: [],
      examples: [
        {
          columns: ["company", "status"],
          records: [
            { company: "Acme", status: "Qualified" },
            { company: "Globex", status: "Won" },
          ],
        },
      ],
    } as unknown as SurfaceComponentDefinition;
    const schema = presentTool.inputSchemaFor?.({
      userId: "user:1",
      presentationContext: {
        target: { channel: "web", surface: "chat" },
        destination: "conversation:1",
        rendererCapabilities: [],
      },
      surfaceCatalog: [recordTable],
    });
    const component = (schema?.properties as Record<string, unknown>).component as {
      description: string;
      oneOf: Array<{
        examples: unknown[];
        properties: Record<string, { const?: string; description?: string }>;
      }>;
    };

    expect(component.description).toContain("Keep name and version separate");
    expect(component.oneOf[0]?.properties.name).toMatchObject({
      const: "RecordTable",
    });
    expect(component.oneOf[0]?.properties.version).toMatchObject({
      const: "1.0",
    });
    expect(component.oneOf[0]?.examples[0]).toEqual({
      name: "RecordTable",
      version: "1.0",
      props: recordTable.examples[0],
    });
  });

  it("reserves Choices for request_input and derives input validation server-side", () => {
    const alert = {
      name: "Alert",
      version: "1.0",
      description: "An important warning.",
      propsSchema: {
        type: "object",
        required: ["message"],
        properties: { message: { type: "string" } },
      },
      events: [],
      examples: [{ message: "Checkout is degraded." }],
    } as unknown as SurfaceComponentDefinition;
    const choices = {
      name: "Choices",
      version: "1.0",
      description: "A mutually exclusive choice.",
      propsSchema: {
        type: "object",
        required: ["question", "choices", "action"],
        properties: {
          question: { type: "string" },
          choices: { type: "array" },
          action: { type: "object" },
        },
      },
      events: [{ name: "choose", description: "Choose.", inputSchema: { type: "object" } }],
      examples: [
        {
          question: "Continue?",
          choices: [{ label: "Yes", value: "yes" }],
          action: { event: "decision.choose" },
        },
      ],
    } as unknown as SurfaceComponentDefinition;
    const ctx = {
      userId: "user:1",
      presentationContext: {
        target: { channel: "web", surface: "chat" } as const,
        destination: "conversation:1",
        rendererCapabilities: [],
      },
      surfaceCatalog: [alert, choices],
    };
    const presentSchema = presentTool.inputSchemaFor?.(ctx);
    const requestSchema = requestInputTool.inputSchemaFor?.(ctx);
    const presentComponent = (presentSchema?.properties as Record<string, unknown>).component as {
      oneOf: Array<{ properties: { name: { const: string } } }>;
    };
    const requestComponent = (requestSchema?.properties as Record<string, unknown>).component as {
      oneOf: Array<{ properties: { name: { const: string } } }>;
    };

    expect(presentComponent.oneOf.map((branch) => branch.properties.name.const)).toEqual(["Alert"]);
    expect(requestComponent.oneOf.map((branch) => branch.properties.name.const)).toEqual([
      "Choices",
    ]);
    expect(requestSchema?.required).toEqual(["component"]);
    expect(requestSchema?.properties).not.toHaveProperty("awaitedSchema");
  });

  it("derives the allowed choice values when request_input executes", async () => {
    const target = { channel: "web", surface: "chat" } as const;
    const result = await requestInputTool.execute(
      {
        component: {
          name: "Choices",
          version: "1.0",
          props: {
            question: "What should we do?",
            choices: [
              { label: "Roll back", value: "rollback" },
              { label: "Investigate", value: "investigate" },
            ],
            action: { event: "incident.choose" },
          },
        },
      },
      {
        userId: "user:1",
        conversationId: "conversation:1",
        presentationContext: presentationContextFor(target, "conversation:1"),
        surfaceCatalog: surfaceCatalogFor(target),
        surfaceCatalogRevision: "revision",
        surfaceRendererManifest: surfaceRendererRegistry.manifestFor(target),
        surfaceStore: new MemorySurfaceArtifactStore(),
        surfaceActionStore: new MemorySurfaceActionStore(),
      }
    );

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data).toMatchObject({
      awaitedSchema: {
        type: "object",
        additionalProperties: false,
        required: ["value"],
        properties: {
          value: {
            anyOf: [
              { type: "string", const: "rollback" },
              { type: "string", const: "investigate" },
            ],
          },
        },
      },
      suspendRun: true,
    });
  });
});
