import type { AgentCapabilityRestrictions } from "@tulipfarm/schema";
import { describe, expect, it } from "vitest";
import {
  agentCanBeOfferedTool,
  agentCanUseSkill,
  agentCapabilityDenial,
} from "./capability-restrictions";

const readOnly: AgentCapabilityRestrictions = { tools: { allowMutating: false } };

describe("agentCapabilityDenial", () => {
  it("permits everything when the Agent authored no restrictions", () => {
    expect(
      agentCapabilityDenial(
        undefined,
        { name: "record_delete", mutating: true },
        { type: "ticket" }
      )
    ).toBeUndefined();
  });

  it("denies a mutating tool for a read-only Agent", () => {
    expect(
      agentCapabilityDenial(readOnly, { name: "record_delete", mutating: true }, {})
    ).toContain("record_delete");
  });

  it("leaves non-mutating tools alone for a read-only Agent", () => {
    expect(
      agentCapabilityDenial(readOnly, { name: "record_list", mutating: false }, {})
    ).toBeUndefined();
  });

  it("denies delegation for a read-only Agent so authority cannot be laundered", () => {
    expect(
      agentCapabilityDenial(readOnly, { name: "delegate_to_agent", mutating: true }, {})
    ).toBeDefined();
  });

  it("exempts flow-control tools from a blanket mutating ban", () => {
    for (const name of ["complete_state", "complete_task", "present", "request_input"]) {
      expect(agentCapabilityDenial(readOnly, { name, mutating: true }, {})).toBeUndefined();
    }
  });

  it("still honours an explicit deny of a flow-control tool", () => {
    expect(
      agentCapabilityDenial(
        { tools: { deny: ["complete_state"] } },
        { name: "complete_state", mutating: true },
        {}
      )
    ).toContain("denied");
  });

  it("denies a tool outside an allow list", () => {
    const restrictions: AgentCapabilityRestrictions = { tools: { allow: ["record_list"] } };
    expect(
      agentCapabilityDenial(restrictions, { name: "record_get", mutating: false }, {})
    ).toContain("outside");
    expect(
      agentCapabilityDenial(restrictions, { name: "record_list", mutating: false }, {})
    ).toBeUndefined();
  });

  it("denies a record action named in the deny list", () => {
    const restrictions: AgentCapabilityRestrictions = {
      records: { actions: { deny: ["delete"] } },
    };
    expect(
      agentCapabilityDenial(
        restrictions,
        { name: "record_delete", mutating: true },
        {
          type: "ticket",
        }
      )
    ).toContain("delete");
  });

  it("scopes a record restriction to the named resource types", () => {
    const restrictions: AgentCapabilityRestrictions = {
      records: { resourceTypes: ["ticket"], actions: { deny: ["delete"] } },
    };
    expect(
      agentCapabilityDenial(
        restrictions,
        { name: "record_delete", mutating: true },
        {
          type: "customer",
        }
      )
    ).toBeUndefined();
    expect(
      agentCapabilityDenial(
        restrictions,
        { name: "record_delete", mutating: true },
        {
          type: "ticket",
        }
      )
    ).toBeDefined();
  });

  it("fails closed when a scoped call hides its target type", () => {
    const restrictions: AgentCapabilityRestrictions = {
      records: { resourceTypes: ["ticket"], actions: { deny: ["delete"] } },
    };
    for (const args of [{}, { type: 7 }, null, "ticket"]) {
      expect(
        agentCapabilityDenial(restrictions, { name: "record_delete", mutating: true }, args)
      ).toBeDefined();
    }
  });

  it("bounds resource type authoring by action and by name", () => {
    const restrictions: AgentCapabilityRestrictions = {
      resourceTypes: { names: ["ticket"], actions: { allow: ["read", "list"] } },
    };
    expect(
      agentCapabilityDenial(
        restrictions,
        { name: "resource_type_update", mutating: true },
        {
          name: "ticket",
        }
      )
    ).toContain("outside");
    expect(
      agentCapabilityDenial(
        restrictions,
        { name: "resource_type_update", mutating: true },
        {
          name: "customer",
        }
      )
    ).toBeUndefined();
  });

  it("says nothing about tools no restriction family covers", () => {
    expect(
      agentCapabilityDenial(
        { records: { actions: { deny: ["delete"] } } },
        { name: "kv_set", mutating: true },
        {}
      )
    ).toBeUndefined();
  });
});

describe("agentCanBeOfferedTool", () => {
  it("offers every tool to an unrestricted Agent", () => {
    expect(agentCanBeOfferedTool(undefined, { name: "record_delete", mutating: true })).toBe(true);
  });

  it("withholds a tool the dispatch phase would refuse outright", () => {
    expect(agentCanBeOfferedTool(readOnly, { name: "record_delete", mutating: true })).toBe(false);
  });

  it("keeps offering a tool whose verdict needs arguments the offer phase lacks", () => {
    const restrictions: AgentCapabilityRestrictions = {
      records: { resourceTypes: ["ticket"], actions: { deny: ["delete"] } },
    };
    expect(agentCanBeOfferedTool(restrictions, { name: "record_delete", mutating: true })).toBe(
      true
    );
  });

  it("withholds a tool an unscoped action restriction always refuses", () => {
    expect(
      agentCanBeOfferedTool(
        { records: { actions: { deny: ["delete"] } } },
        { name: "record_delete", mutating: true }
      )
    ).toBe(false);
  });
});

describe("Skill restrictions", () => {
  const onlyAudit: AgentCapabilityRestrictions = { skills: { allow: ["invoice-audit"] } };
  const noDeploy: AgentCapabilityRestrictions = { skills: { deny: ["deploy"] } };
  const skill = { name: "skill", mutating: false };

  it("permits an allowed Skill", () => {
    expect(agentCapabilityDenial(onlyAudit, skill, { name: "invoice-audit" })).toBeUndefined();
  });

  it("denies a Skill outside the allow list", () => {
    expect(agentCapabilityDenial(onlyAudit, skill, { name: "deploy" })).toContain("deploy");
  });

  it("denies a named Skill even when everything else is permitted", () => {
    expect(agentCapabilityDenial(noDeploy, skill, { name: "deploy" })).toContain("deploy");
    expect(agentCapabilityDenial(noDeploy, skill, { name: "invoice-audit" })).toBeUndefined();
  });

  it("denies a run of a forbidden Skill, not just a read of it", () => {
    // `mode` raises the authorized action but never changes which Skill is being reached.
    expect(
      agentCapabilityDenial(onlyAudit, skill, { name: "deploy", mode: "run", command: "ship" })
    ).toContain("deploy");
  });

  it("fails closed when an allow-listed Agent's call names no Skill", () => {
    expect(agentCapabilityDenial(onlyAudit, skill, {})).toBeDefined();
  });

  it("stays silent when only a deny list exists and the call names no Skill", () => {
    // Nothing is forbidden by name here, so there is no verdict to reach without a target.
    expect(agentCapabilityDenial(noDeploy, skill, {})).toBeUndefined();
  });

  it("governs only the Tool that loads a Skill", () => {
    expect(agentCapabilityDenial(onlyAudit, { name: "skill_list", mutating: false }, {})).toBe(
      undefined
    );
  });

  it("keeps the skill Tool offered, since one Tool reaches every Skill", () => {
    expect(agentCanBeOfferedTool(onlyAudit, skill)).toBe(true);
  });
});

describe("agentCanUseSkill", () => {
  it("treats an Agent with no restrictions as unrestricted", () => {
    expect(agentCanUseSkill(undefined, "deploy")).toBe(true);
    expect(agentCanUseSkill({ tools: { deny: ["record_delete"] } }, "deploy")).toBe(true);
  });

  it("agrees with the dispatch verdict for the same Skill", () => {
    const restrictions: AgentCapabilityRestrictions = { skills: { allow: ["invoice-audit"] } };

    expect(agentCanUseSkill(restrictions, "invoice-audit")).toBe(true);
    expect(agentCanUseSkill(restrictions, "deploy")).toBe(false);
  });
});
