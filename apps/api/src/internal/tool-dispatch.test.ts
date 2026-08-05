import type { ArtifactService } from "@tulipfarm/run-kernel";
import { RUN_EXECUTOR_PRINCIPAL_REF, requestArtifactId } from "@tulipfarm/run-kernel";
import { describe, expect, it, vi } from "vitest";
import type { ToolApprovalDecision, ToolApprovalService } from "../approvals/tool-approvals";
import { ToolRegistry } from "../broker/tool-adapter";
import { DEFAULT_ASSISTANT_NAME } from "../soul/agents/platform-agents";
import { presentationContextFor } from "../surfaces/renderer-registry";
import { BUSINESS_ID, CONVERSATION_ID, RUN_ID, turn } from "../test/turn-host-fixtures";
import { err, ok, type RequestContext, type ToolDef } from "../tools/types";
import { RegistryToolDispatcher } from "./tool-dispatch";
import type { TurnAuthority } from "./turn-host";

const AUTHORITY: TurnAuthority = {
  businessId: BUSINESS_ID,
  runId: RUN_ID,
  turn: turn(),
  subject: { kind: "user", id: "user-1" },
  source: "chat",
  bundleDigest: "bundle-digest",
};

function toolDef(overrides: Partial<ToolDef> = {}): ToolDef {
  return {
    name: "echo",
    tier: "platform",
    mutating: false,
    description: "echoes",
    inputSchema: {
      type: "object",
      required: ["text"],
      additionalProperties: false,
      properties: { text: { type: "string" } },
    },
    execute: async (args) => ok(args),
    ...overrides,
  };
}

function fakeArtifacts(content: unknown = {}) {
  return {
    read: vi.fn(async () => ({ content })),
  };
}

function makeDispatcher(
  tools: readonly ToolDef[],
  artifacts = fakeArtifacts(),
  approvals?: ToolApprovalService
) {
  const registry = new ToolRegistry();
  for (const tool of tools) registry.register(tool);
  return {
    registry,
    artifacts,
    dispatcher: new RegistryToolDispatcher({
      registry,
      artifacts: artifacts as unknown as ArtifactService,
      ...(approvals === undefined ? {} : { approvals }),
    }),
  };
}

/** The web chat fallback target every Run with no Channel delivery resolves to. */
const WEB_PRESENTATION_CONTEXT = presentationContextFor(
  { channel: "web", surface: "chat" },
  `conversation:${CONVERSATION_ID}`
);

/** A standing decision, as the durable service would report it. */
function fakeApprovals(decision: ToolApprovalDecision) {
  const decide = vi.fn(async () => decision);
  return { decide, service: { decide } as unknown as ToolApprovalService };
}

describe("RegistryToolDispatcher", () => {
  it("runs the Tool as the Run's recorded subject", async () => {
    const seen: RequestContext[] = [];
    const { dispatcher, artifacts } = makeDispatcher([
      toolDef({
        execute: async (args, context) => {
          seen.push(context);
          return ok(args);
        },
      }),
    ]);

    await expect(
      dispatcher.dispatch(AUTHORITY, { callId: "c1", name: "echo", arguments: { text: "hi" } })
    ).resolves.toEqual({ status: "succeeded", output: { text: "hi" } });
    expect(seen).toEqual([
      {
        userId: "user-1",
        conversationId: CONVERSATION_ID,
        runId: RUN_ID,
        agentId: DEFAULT_ASSISTANT_NAME,
        autonomy: undefined,
        guardrailRevision: "none",
        presentationContext: WEB_PRESENTATION_CONTEXT,
        surfaceStore: undefined,
        surfaceActionStore: undefined,
        surfaceComponents: [],
        surfaceCatalog: expect.any(Array),
        surfaceCatalogRevision: expect.any(String),
        surfaceRendererManifest: expect.anything(),
      },
    ]);
    // Which Agent this turn is comes from the immutable request, read as the Run executor.
    expect(artifacts.read).toHaveBeenCalledWith(
      expect.objectContaining({
        artifactId: requestArtifactId(RUN_ID),
        reader: RUN_EXECUTOR_PRINCIPAL_REF,
      })
    );
  });

  it("denies a Tool never registered, without running it", async () => {
    const execute = vi.fn(async () => ok({}));
    const { dispatcher } = makeDispatcher([toolDef({ name: "present", execute })]);

    // Every Run resolves a presentation target (Channel destination, or the web chat fallback),
    // so "present" is offered here — only a genuinely unregistered name is denied.
    await expect(
      dispatcher.dispatch(AUTHORITY, { callId: "c2", name: "nope", arguments: {} })
    ).resolves.toMatchObject({ status: "denied" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("refuses arguments the Tool's schema rejects before execute sees them", async () => {
    const execute = vi.fn(async () => ok({}));
    const { dispatcher } = makeDispatcher([toolDef({ execute })]);

    await expect(
      dispatcher.dispatch(AUTHORITY, { callId: "c1", name: "echo", arguments: { text: 7 } })
    ).resolves.toMatchObject({ status: "invalid_arguments" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("parks a gated mutating call instead of running it, once arguments are known good", async () => {
    const execute = vi.fn(async () => ok({}));
    const approvals = fakeApprovals({ status: "pending", approvalId: "approval-1" });
    const { dispatcher } = makeDispatcher(
      [toolDef({ name: "wipe", mutating: true, execute })],
      fakeArtifacts({ autonomy: "approval-required" }),
      approvals.service
    );

    await expect(
      dispatcher.dispatch(AUTHORITY, { callId: "c1", name: "wipe", arguments: { text: "hi" } })
    ).resolves.toEqual({ status: "awaiting_approval", approvalId: "approval-1" });
    expect(execute).not.toHaveBeenCalled();
    // Keyed by the intent, so the resumed loop's new call id resolves to this same decision.
    expect(approvals.decide).toHaveBeenCalledWith(
      expect.objectContaining({ runId: RUN_ID, toolName: "wipe", args: { text: "hi" } })
    );
  });

  it("runs the call the human already approved, and refuses the one they refused", async () => {
    const approved = vi.fn(async () => ok({ done: true }));
    const { dispatcher } = makeDispatcher(
      [toolDef({ name: "wipe", mutating: true, execute: approved })],
      fakeArtifacts({ autonomy: "approval-required" }),
      fakeApprovals({ status: "approved" }).service
    );
    await expect(
      dispatcher.dispatch(AUTHORITY, { callId: "c2", name: "wipe", arguments: { text: "hi" } })
    ).resolves.toEqual({ status: "succeeded", output: { done: true } });
    expect(approved).toHaveBeenCalledTimes(1);

    const refused = vi.fn(async () => ok({}));
    const denied = makeDispatcher(
      [toolDef({ name: "wipe", mutating: true, execute: refused })],
      fakeArtifacts({ autonomy: "approval-required" }),
      fakeApprovals({ status: "denied", reason: "denied by operator" }).service
    );
    await expect(
      denied.dispatcher.dispatch(AUTHORITY, {
        callId: "c3",
        name: "wipe",
        arguments: { text: "hi" },
      })
    ).resolves.toEqual({ status: "denied", reason: "denied by operator" });
    expect(refused).not.toHaveBeenCalled();
  });

  it("asks nobody about a read, or about a Tool that opted out of the gate", async () => {
    const approvals = fakeApprovals({ status: "pending", approvalId: "approval-1" });
    const { dispatcher } = makeDispatcher(
      [
        toolDef({ name: "echo" }),
        toolDef({ name: "wipe", mutating: true, requiresApproval: false }),
      ],
      fakeArtifacts({ autonomy: "approval-required" }),
      approvals.service
    );

    for (const name of ["echo", "wipe"]) {
      await expect(
        dispatcher.dispatch(AUTHORITY, { callId: name, name, arguments: { text: "hi" } })
      ).resolves.toMatchObject({ status: "succeeded" });
    }
    expect(approvals.decide).not.toHaveBeenCalled();
  });

  it("asks nobody when the request did not ask to be supervised", async () => {
    const approvals = fakeApprovals({ status: "pending", approvalId: "approval-1" });
    const { dispatcher } = makeDispatcher(
      [toolDef({ name: "wipe", mutating: true })],
      fakeArtifacts({ autonomy: "full" }),
      approvals.service
    );

    await expect(
      dispatcher.dispatch(AUTHORITY, { callId: "c1", name: "wipe", arguments: { text: "hi" } })
    ).resolves.toMatchObject({ status: "succeeded" });
    expect(approvals.decide).not.toHaveBeenCalled();
  });

  it("hands a failure back as a result the model reads, never as a thrown turn-ender", async () => {
    const { dispatcher } = makeDispatcher([
      toolDef({
        name: "boom",
        inputSchema: { type: "object" },
        execute: async () => {
          throw new Error("secret internal detail");
        },
      }),
      toolDef({
        name: "declined",
        inputSchema: { type: "object" },
        execute: async () => err("not_found", "no such record"),
      }),
    ]);

    const raised = await dispatcher.dispatch(AUTHORITY, {
      callId: "c1",
      name: "boom",
      arguments: {},
    });
    expect(raised).toEqual({
      status: "failed",
      reason: 'tool "boom" raised an internal error',
    });

    await expect(
      dispatcher.dispatch(AUTHORITY, { callId: "c2", name: "declined", arguments: {} })
    ).resolves.toEqual({ status: "failed", reason: "no such record" });
  });

  it("classifies a handler's schema rejection as invalid_arguments, not a generic failure", async () => {
    // A validation_error from inside execute() (e.g. a resource-type's own required fields, which
    // the outer AJV check on the generic tool schema cannot know about) must count against the
    // loop's repair budget the same as an outer schema failure — otherwise the model can retry the
    // same invalid arguments forever without the budget ever tripping.
    const { dispatcher } = makeDispatcher([
      toolDef({
        name: "record_create",
        inputSchema: { type: "object" },
        execute: async () => err("validation_error", "must have required property 'status'"),
      }),
    ]);

    await expect(
      dispatcher.dispatch(AUTHORITY, { callId: "c1", name: "record_create", arguments: {} })
    ).resolves.toEqual({
      status: "invalid_arguments",
      reason: "must have required property 'status'",
    });
  });
});
