/** The capability catalog must only advertise gates the auth layer can evaluate. */

import { RoleGrantSchema } from "@tulipfarm/schema";
import type { ToolDef } from "@tulipfarm/tool-host";
import { describe, expect, it } from "vitest";
import {
  AUTHORABLE_ACTION,
  AUTHORABLE_RESOURCE,
  areaLabel,
  buildCapabilityCatalog,
  capabilityLabel,
} from "./capabilities";

function toolWith(
  name: string,
  action: string,
  resources: readonly string[],
  mutating = false
): ToolDef {
  return {
    name,
    tier: "platform",
    mutating,
    description: `${name} description`,
    inputSchema: { type: "object" },
    execute: async () => ({ ok: true, data: {} }) as never,
    definition: {
      name,
      authorization: { action, resources: [...resources] },
    } as unknown as ToolDef["definition"],
  };
}

function allCapabilities(catalog: ReturnType<typeof buildCapabilityCatalog>) {
  return catalog.areas.flatMap((area) => area.capabilities);
}

describe("the authorable patterns match the schema that will validate the level", () => {
  /** Every catalog capability must be authorable by RoleSchema. */
  it("uses the same action pattern the published Role schema enforces", () => {
    const properties = RoleGrantSchema.properties as {
      actions: { items: { pattern: string } };
    };
    expect(AUTHORABLE_ACTION.source).toBe(properties.actions.items.pattern);
  });

  it("uses the same resource pattern the published Role schema enforces", () => {
    const properties = RoleGrantSchema.properties as {
      resource: { properties: { types: { items: { pattern: string } } } };
    };
    expect(AUTHORABLE_RESOURCE.source).toBe(properties.resource.properties.types.items.pattern);
  });
});

describe("buildCapabilityCatalog", () => {
  it("reads the action and resources off the Tool's own declaration", () => {
    const catalog = buildCapabilityCatalog([
      toolWith("github_issue_create", "github.issue.create", ["integration.github"], true),
    ]);
    expect(allCapabilities(catalog)).toEqual([
      {
        id: "github.issue.create",
        action: "github.issue.create",
        resourceTypes: ["integration.github"],
        label: "Add issue",
        changesThings: true,
        tools: ["github_issue_create"],
      },
    ]);
  });

  it("groups two Tools needing the same action into one capability", () => {
    const catalog = buildCapabilityCatalog([
      toolWith("a", "slack.message.send", ["integration.slack"]),
      toolWith("b", "slack.message.send", ["integration.slack"]),
    ]);
    const capabilities = allCapabilities(catalog);
    expect(capabilities).toHaveLength(1);
    expect(capabilities[0]?.tools).toEqual(["a", "b"]);
  });

  /** Shared grants are described by their most powerful use. */
  it("treats a capability as changing things when any of its Tools does", () => {
    const catalog = buildCapabilityCatalog([
      toolWith("reader", "record.export", ["record"], false),
      toolWith("writer", "record.export", ["record"], true),
    ]);
    expect(allCapabilities(catalog)[0]?.changesThings).toBe(true);
  });

  it("treats a writing verb as changing things even when the Tool claims otherwise", () => {
    const catalog = buildCapabilityCatalog([toolWith("t", "kv.delete", ["platform.kv"], false)]);
    expect(allCapabilities(catalog)[0]?.changesThings).toBe(true);
  });

  it("treats a reading verb on a non-mutating Tool as not changing things", () => {
    const catalog = buildCapabilityCatalog([toolWith("t", "kv.get", ["platform.kv"], false)]);
    expect(allCapabilities(catalog)[0]?.changesThings).toBe(false);
  });

  it("unions the resource types when Tools sharing an action declare different ones", () => {
    const catalog = buildCapabilityCatalog([
      toolWith("a", "record.read", ["record"]),
      toolWith("b", "record.read", ["record.ticket"]),
    ]);
    expect(allCapabilities(catalog)[0]?.resourceTypes).toEqual(["record", "record.ticket"]);
  });

  it("skips a Tool that declares no authorization at all", () => {
    const bare: ToolDef = {
      name: "bare",
      tier: "platform",
      mutating: false,
      description: "",
      inputSchema: {},
      execute: async () => ({ ok: true, data: {} }) as never,
    };
    expect(buildCapabilityCatalog([bare])).toEqual({ areas: [], unavailable: [] });
  });

  describe("what cannot be authored is reported, never offered", () => {
    /** Every advertised scope level must be accepted by the auth schema. */
    it("reports a Tool that declares no resource", () => {
      const catalog = buildCapabilityCatalog([toolWith("t", "thing.do", [])]);
      expect(allCapabilities(catalog)).toEqual([]);
      expect(catalog.unavailable).toEqual([
        { action: "thing.do", resourceTypes: [], tools: ["t"], reason: "no_resource_declared" },
      ]);
    });

    it("reports a resource the authoring schema would reject", () => {
      // Three segments: `AUTHORABLE_RESOURCE` admits at most two.
      const catalog = buildCapabilityCatalog([toolWith("t", "thing.do", ["a.b.c"])]);
      expect(allCapabilities(catalog)).toEqual([]);
      expect(catalog.unavailable[0]?.reason).toBe("resource_not_authorable");
    });

    it("reports a single-segment action the authoring schema would reject", () => {
      const catalog = buildCapabilityCatalog([toolWith("t", "do", ["record"])]);
      expect(allCapabilities(catalog)).toEqual([]);
      expect(catalog.unavailable[0]?.reason).toBe("action_not_authorable");
    });

    it("never lets a wildcard through as a capability", () => {
      const catalog = buildCapabilityCatalog([
        toolWith("star", "*", ["*"]),
        toolWith("half", "record.read", ["*"]),
      ]);
      expect(allCapabilities(catalog)).toEqual([]);
      expect(catalog.unavailable.map((entry) => entry.action).sort()).toEqual(["*", "record.read"]);
    });

    it("names every Tool that wanted an unavailable capability", () => {
      const catalog = buildCapabilityCatalog([
        toolWith("first", "thing.do", []),
        toolWith("second", "thing.do", []),
      ]);
      expect(catalog.unavailable[0]?.tools).toEqual(["first", "second"]);
    });
  });

  it("sorts areas and the capabilities inside them, so the list is stable between boots", () => {
    const catalog = buildCapabilityCatalog([
      toolWith("z", "slack.message.send", ["integration.slack"]),
      toolWith("a", "github.issue.create", ["integration.github"]),
      toolWith("b", "github.issue.list", ["integration.github"]),
    ]);
    expect(catalog.areas.map((area) => area.label)).toEqual(["GitHub", "Slack"]);
    expect(catalog.areas[0]?.capabilities.map((capability) => capability.label)).toEqual([
      "Add issue",
      "See every issue",
    ]);
  });
});

describe("capabilityLabel", () => {
  it.each([
    ["github.pull_request.create", "Add pull request"],
    ["slack.message.send", "Send message"],
    ["github.repository.list", "See every repository"],
    ["record.delete", "Delete record"],
    ["soul.skill.activate", "Turn on skill"],
  ])("turns %s into %s", (action, expected) => {
    expect(capabilityLabel(action)).toBe(expected);
  });

  /** `read` and `list` are separate grants, so their descriptions must differ. */
  it.each([
    ["soul.agent.read", "soul.agent.list"],
    ["record.read", "record.list"],
    ["kv.get", "kv.list"],
    ["github.content.read", "github.content.list"],
  ])("distinguishes %s from %s", (readAction, listAction) => {
    expect(capabilityLabel(readAction)).not.toBe(capabilityLabel(listAction));
  });

  /** With no object segment, fall back to the area label. */
  it("uses the area as the object when the action has no middle segment", () => {
    expect(capabilityLabel("soul.publish")).toBe("Publish soul");
  });

  /** Multi-word final segments already name their object; do not append the area again. */
  it.each([
    ["frontend.invoke_action", "Invoke action"],
    ["frontend.prefill_form", "Prefill form"],
    ["surface.request_input", "Request input"],
  ])("does not append the area to the compound verb in %s", (action, expected) => {
    expect(capabilityLabel(action)).toBe(expected);
  });

  it("uses an unmapped verb verbatim rather than hiding the capability", () => {
    expect(capabilityLabel("github.branch.rebase")).toBe("Rebase branch");
  });

  /** Guard against duplicate human labels inside one capability area. */
  it("never places two identically labelled capabilities in the same area", () => {
    const catalog = buildCapabilityCatalog([
      toolWith("agent_read", "soul.agent.read", ["soul.agent"]),
      toolWith("agent_list", "soul.agent.list", ["soul.agent"]),
      toolWith("skill_read", "soul.skill.read", ["soul.skill"]),
      toolWith("skill_list", "soul.skill.list", ["soul.skill"]),
    ]);
    for (const area of catalog.areas) {
      const labels = area.capabilities.map((capability) => capability.label);
      expect(new Set(labels).size).toBe(labels.length);
    }
  });
});

describe("areaLabel", () => {
  it("uses the mapped name where there is one", () => {
    expect(areaLabel("github")).toBe("GitHub");
  });

  /** New integration capabilities should get reasonable labels the day they ship. */
  it("falls back to the segment itself for an area nobody has named", () => {
    expect(areaLabel("linear")).toBe("Linear");
    expect(areaLabel("google_docs")).toBe("Google docs");
  });
});
