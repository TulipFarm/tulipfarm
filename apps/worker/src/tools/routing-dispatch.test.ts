import type { ToolDispatchRequest, ToolDispatchResult } from "@tulipfarm/agent-runtime";
import type { HostedToolCall, TurnAuthority } from "@tulipfarm/tool-host";
import { describe, expect, it } from "vitest";
import type { LocalToolHost } from "./local-host";
import { RoutingToolDispatch } from "./routing-dispatch";

const AUTHORITY: TurnAuthority = {
  businessId: "tulipfarm-local",
  runId: "run-1",
  turn: { id: "turn-1", conversationId: "conv-1", attempt: 1 },
  subject: { kind: "user", id: "user-1" },
  source: "chat",
  bundleDigest: "sha256:bundle",
};

function request(name: string, runId = "run-1"): ToolDispatchRequest {
  return {
    businessId: AUTHORITY.businessId,
    runId,
    stateId: "invoke",
    callId: `call-${name}`,
    name,
    arguments: { a: 1 },
  };
}

class RecordingRemote {
  readonly calls: ToolDispatchRequest[] = [];

  async dispatch(input: ToolDispatchRequest): Promise<ToolDispatchResult> {
    this.calls.push(input);
    return { status: "succeeded", callId: input.callId, output: "remote" };
  }
}

function localHost(
  names: readonly string[],
  ready: (name: string) => Promise<boolean> = async () => true
): LocalToolHost & { calls: HostedToolCall[] } {
  const calls: HostedToolCall[] = [];
  return {
    calls,
    hostedNames: new Set(names),
    ready,
    dispatcher: {
      async dispatch(_authority, call) {
        calls.push(call);
        return { status: "succeeded", output: "local" };
      },
    },
  };
}

const SILENT = { warn: () => {} };

function outputOf(result: ToolDispatchResult): unknown {
  return result.status === "succeeded" ? result.output : result.status;
}

describe("RoutingToolDispatch", () => {
  it("executes a hosted Tool in process under the Run's own authority", async () => {
    const local = localHost(["kv_set"]);
    const remote = new RecordingRemote();
    const routing = new RoutingToolDispatch(
      local,
      { authority: async () => AUTHORITY },
      remote,
      SILENT
    );

    const result = await routing.dispatch(request("kv_set"));

    expect(result).toEqual({ status: "succeeded", callId: "call-kv_set", output: "local" });
    expect(local.calls).toEqual([{ callId: "call-kv_set", name: "kv_set", arguments: { a: 1 } }]);
    expect(remote.calls).toEqual([]);
  });

  it("leaves every unhosted Tool on the control-plane path", async () => {
    const local = localHost(["kv_set"]);
    const remote = new RecordingRemote();
    const routing = new RoutingToolDispatch(
      local,
      {
        authority: async () => {
          throw new Error("authority must not be read for a remote Tool");
        },
      },
      remote,
      SILENT
    );

    const result = await routing.dispatch(request("create_resource_type"));

    expect(result.status).toBe("succeeded");
    expect(remote.calls.map((call) => call.name)).toEqual(["create_resource_type"]);
    expect(local.calls).toEqual([]);
  });

  it("reads authority once per Run, however many hosted calls it makes", async () => {
    let reads = 0;
    const local = localHost(["kv_set", "kv_get"]);
    const routing = new RoutingToolDispatch(
      local,
      {
        authority: async () => {
          reads += 1;
          return AUTHORITY;
        },
      },
      new RecordingRemote(),
      SILENT
    );

    await Promise.all([routing.dispatch(request("kv_set")), routing.dispatch(request("kv_get"))]);
    await routing.dispatch(request("kv_set"));

    expect(reads).toBe(1);
    expect(local.calls).toHaveLength(3);
  });

  it("falls back to the control plane when the Run names no Turn to act for", async () => {
    const local = localHost(["kv_set"]);
    const remote = new RecordingRemote();
    const routing = new RoutingToolDispatch(
      local,
      { authority: async () => undefined },
      remote,
      SILENT
    );

    const result = await routing.dispatch(request("kv_set"));

    expect(outputOf(result)).toBe("remote");
    expect(local.calls).toEqual([]);
  });

  it("does not cache a failed authority read, and never turns it into a denial", async () => {
    let attempts = 0;
    const local = localHost(["kv_set"]);
    const remote = new RecordingRemote();
    const routing = new RoutingToolDispatch(
      local,
      {
        authority: async () => {
          attempts += 1;
          if (attempts === 1) throw new Error("boom");
          return AUTHORITY;
        },
      },
      remote,
      SILENT
    );

    const first = await routing.dispatch(request("kv_set"));
    const second = await routing.dispatch(request("kv_set"));

    expect(outputOf(first)).toBe("remote");
    expect(outputOf(second)).toBe("local");
    expect(attempts).toBe(2);
  });

  it("forgets a Run's authority once it is finished", async () => {
    let reads = 0;
    const local = localHost(["kv_set"]);
    const routing = new RoutingToolDispatch(
      local,
      {
        authority: async () => {
          reads += 1;
          return AUTHORITY;
        },
      },
      new RecordingRemote(),
      SILENT
    );

    await routing.dispatch(request("kv_set"));
    routing.forget("run-1");
    await routing.dispatch(request("kv_set"));

    expect(reads).toBe(2);
  });
});

describe("RoutingToolDispatch business scope", () => {
  it("refuses to execute locally when the Run and the API disagree on the deployment", async () => {
    const local = localHost(["kv_set"]);
    const remote = new RecordingRemote();
    const routing = new RoutingToolDispatch(
      local,
      { authority: async () => ({ ...AUTHORITY, businessId: "somewhere-else" }) },
      remote,
      SILENT
    );

    const result = await routing.dispatch(request("kv_set"));

    expect(outputOf(result)).toBe("remote");
    expect(local.calls).toEqual([]);
  });
});

describe("RoutingToolDispatch readiness", () => {
  it("routes remote when this process cannot answer as well as the control plane", async () => {
    const local = localHost(["kv_get"], async () => false);
    const remote = new RecordingRemote();
    const routing = new RoutingToolDispatch(
      local,
      { authority: async () => AUTHORITY },
      remote,
      SILENT
    );

    const result = await routing.dispatch(request("kv_get"));

    expect(outputOf(result)).toBe("remote");
    expect(local.calls).toEqual([]);
  });

  it("asks readiness before spending an authority read", async () => {
    const local = localHost(["kv_get"], async () => false);
    const remote = new RecordingRemote();
    let authorityReads = 0;
    const routing = new RoutingToolDispatch(
      local,
      {
        authority: async () => {
          authorityReads += 1;
          return AUTHORITY;
        },
      },
      remote,
      SILENT
    );

    await routing.dispatch(request("kv_get"));

    expect(authorityReads).toBe(0);
  });
});
