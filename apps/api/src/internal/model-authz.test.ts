import type { AccessGrant, AuthorityLayer } from "@tulipfarm/authz";
import type { AuthorityPrincipal, LiveAuthorityLayerResolver } from "@tulipfarm/tool-host";
import { describe, expect, it, vi } from "vitest";
import { type ModelGateMode, ModelSelectorGate, modelGateModeFromEnv } from "./model-authz";

/** A resolver stub returning whatever grants a layer name was seeded with. */
function resolver(grantsByLayer: Record<string, readonly AccessGrant[]>): {
  resolver: LiveAuthorityLayerResolver;
  asked: () => string[];
} {
  const asked: string[] = [];
  const stub = {
    async resolvePrincipalLayer(name: string, principal: AuthorityPrincipal) {
      asked.push(`${name}:${principal.kind}:${principal.id}`);
      return { name, grants: grantsByLayer[name] ?? [] } satisfies AuthorityLayer;
    },
  };
  return { resolver: stub as unknown as LiveAuthorityLayerResolver, asked: () => asked };
}

const ALLOW_ANY_MODEL: AccessGrant = {
  action: "model.invoke",
  resourceType: "platform.model",
  effect: "allow",
};

function gate(
  mode: ModelGateMode,
  grantsByLayer: Record<string, readonly AccessGrant[]>,
  log?: (event: Record<string, unknown>, message: string) => void
) {
  const built = resolver(grantsByLayer);
  return {
    gate: new ModelSelectorGate({
      resolver: built.resolver,
      mode,
      ...(log === undefined ? {} : { log }),
    }),
    asked: built.asked,
  };
}

const REQUEST = {
  businessId: "biz-1",
  subject: { kind: "user", id: "user-1" },
  agentId: "assistant",
  selector: "claude-opus-4-8",
};

describe("ModelSelectorGate", () => {
  it("denies by default, because no grant names the model resource", () => {
    // Invariant 3: an absent grant denies. Before this gate there was no resource to grant at
    // all, so "may this principal use this model" had no expressible answer.
    const { gate: g } = gate("shadow", {});
    return expect(g.authorize(REQUEST)).resolves.toMatchObject({
      wouldDeny: true,
      decision: { allowed: false, reason: "no_matching_allow" },
    });
  });

  it("allows when every layer grants the model resource", async () => {
    const { gate: g } = gate("shadow", {
      user: [ALLOW_ANY_MODEL],
      agent: [ALLOW_ANY_MODEL],
    });

    await expect(g.authorize(REQUEST)).resolves.toMatchObject({
      wouldDeny: false,
      decision: { allowed: true },
    });
  });

  it("intersects the agent layer with the caller's, never unions it", async () => {
    // ADR-009 / D9: an Agent cannot widen its delegator's reach.
    const { gate: g } = gate("shadow", { user: [ALLOW_ANY_MODEL], agent: [] });

    await expect(g.authorize(REQUEST)).resolves.toMatchObject({
      wouldDeny: true,
      decision: { allowed: false, deniedLayer: "agent" },
    });
  });

  it("honours a grant scoped to one model and denies the others", async () => {
    const onlyHaiku: AccessGrant = { ...ALLOW_ANY_MODEL, recordSelector: "claude-haiku-4-5" };
    const { gate: g } = gate("shadow", { user: [onlyHaiku], agent: [onlyHaiku] });

    await expect(g.authorize({ ...REQUEST, selector: "claude-haiku-4-5" })).resolves.toMatchObject({
      wouldDeny: false,
    });
    await expect(g.authorize({ ...REQUEST, selector: "claude-opus-4-8" })).resolves.toMatchObject({
      wouldDeny: true,
    });
  });

  it("fails closed on a subject kind it cannot map to a principal", async () => {
    // An unmappable kind is not a principal we can reason about. Intersecting nothing would
    // read as "allowed"; `no_layers` says we could not decide.
    const { gate: g, asked } = gate("shadow", { user: [ALLOW_ANY_MODEL] });

    await expect(
      g.authorize({ ...REQUEST, subject: { kind: "wat", id: "x" } })
    ).resolves.toMatchObject({ wouldDeny: true, decision: { reason: "no_layers" } });
    expect(asked()).toEqual([]);
  });

  it("decides against the model resource for every principal kind it can map", async () => {
    const { gate: g, asked } = gate("shadow", {});
    await g.authorize({ ...REQUEST, subject: { kind: "routine", id: "nightly" } });

    expect(asked()[0]).toBe("user:routine:nightly");
  });
});

describe("ModelSelectorGate — shadow mode", () => {
  it("reports a would-deny without enforcing it", async () => {
    // §5 "declare before enforce": the flip is the step that can lock a deployment out of its own
    // models, so shadow must report exactly what enforcing would do and change nothing.
    const log = vi.fn();
    const { gate: g } = gate("shadow", {}, log);

    const outcome = await g.authorize(REQUEST);

    expect(outcome).toMatchObject({ wouldDeny: true, enforced: false });
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]?.[0]).toMatchObject({
      event: "authz.model.decision",
      mode: "shadow",
      model: "claude-opus-4-8",
      subject: "user:user-1",
      agentId: "assistant",
      enforced: false,
    });
  });

  it("says nothing when the decision is an allow", async () => {
    const log = vi.fn();
    const { gate: g } = gate("shadow", { user: [ALLOW_ANY_MODEL], agent: [ALLOW_ANY_MODEL] }, log);

    await g.authorize(REQUEST);

    expect(log).not.toHaveBeenCalled();
  });

  it("marks the same decision enforced when the mode is flipped", async () => {
    const log = vi.fn();
    const { gate: g } = gate("enforcing", {}, log);

    await expect(g.authorize(REQUEST)).resolves.toMatchObject({
      wouldDeny: true,
      enforced: true,
    });
    expect(log.mock.calls[0]?.[0]).toMatchObject({ mode: "enforcing", enforced: true });
  });
});

describe("modelGateModeFromEnv", () => {
  it("defaults to shadow, so a deployment is never locked out by an upgrade", () => {
    expect(modelGateModeFromEnv({})).toBe("shadow");
    expect(modelGateModeFromEnv({ AUTHZ_MODEL_GATE: "" })).toBe("shadow");
    expect(modelGateModeFromEnv({ AUTHZ_MODEL_GATE: "yes" })).toBe("shadow");
  });

  it("enforces only on the exact opt-in value", () => {
    expect(modelGateModeFromEnv({ AUTHZ_MODEL_GATE: "enforcing" })).toBe("enforcing");
  });
});
