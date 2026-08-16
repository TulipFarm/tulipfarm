import { describe, expect, it } from "vitest";
import {
  delegatedAuthorityLayer,
  delegatedDataClassRequest,
  delegatedToolRequest,
} from "./delegated-authority";
import { decideEffectivePermission } from "./effective";

const GRANTED = { tools: ["record_list"], classifications: ["business_record"] };

describe("delegated authority compiles into the one intersection", () => {
  it("allows a Tool both the Agent config and the grant hold", () => {
    const decision = decideEffectivePermission(
      [
        delegatedAuthorityLayer("soul", { tools: ["record_list"], classifications: [] }),
        delegatedAuthorityLayer("delegation", GRANTED),
      ],
      delegatedToolRequest("record_list")
    );

    expect(decision).toEqual({ allowed: true, reason: "allowed" });
  });

  it("denies a Tool the grant never held, naming the layer that refused", () => {
    const decision = decideEffectivePermission(
      [
        delegatedAuthorityLayer("soul", { tools: ["record_create"], classifications: [] }),
        delegatedAuthorityLayer("delegation", GRANTED),
      ],
      delegatedToolRequest("record_create")
    );

    expect(decision).toEqual({
      allowed: false,
      reason: "no_matching_allow",
      deniedLayer: "delegation",
    });
  });

  it("denies a Tool the grant holds that the Agent config never offered", () => {
    const decision = decideEffectivePermission(
      [
        delegatedAuthorityLayer("soul", { tools: [], classifications: [] }),
        delegatedAuthorityLayer("delegation", GRANTED),
      ],
      delegatedToolRequest("record_list")
    );

    expect(decision.allowed).toBe(false);
    expect(decision.deniedLayer).toBe("soul");
  });

  it("keeps Tool and data-class grants apart, so a Tool grant is not a data grant", () => {
    const layer = [delegatedAuthorityLayer("delegation", GRANTED)];

    expect(
      decideEffectivePermission(layer, delegatedDataClassRequest("business_record")).allowed
    ).toBe(true);
    expect(decideEffectivePermission(layer, delegatedDataClassRequest("pii")).allowed).toBe(false);
    expect(decideEffectivePermission(layer, delegatedToolRequest("business_record")).allowed).toBe(
      false
    );
  });

  it("fails closed on an empty grant", () => {
    const decision = decideEffectivePermission(
      [delegatedAuthorityLayer("delegation", { tools: [], classifications: [] })],
      delegatedToolRequest("record_list")
    );

    expect(decision.allowed).toBe(false);
  });
});
