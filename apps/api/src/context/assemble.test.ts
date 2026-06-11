import { describe, expect, it } from "vitest";
import type { KnowledgeDocument } from "../knowledge/types";
import type { WorkingMemoryDoc } from "../memory/working-memory";
import { type AssembleContext, assembleSystemPrompt } from "./assemble";

const EPOCH = new Date(0);

function mem(key: string, value: string): WorkingMemoryDoc {
  return { _id: `u:${key}`, userId: "u", key, value, createdAt: EPOCH, lastWrittenAt: EPOCH };
}

function govDoc(title: string, body: string): KnowledgeDocument {
  return {
    _id: title,
    title,
    content: body,
    plainText: body,
    source: "authored",
    sourceId: title,
    domain: null,
    tags: [],
    active: true,
    alwaysLoadForAgents: true,
    version: 1,
    createdAt: EPOCH,
    updatedAt: EPOCH,
  };
}

function baseCtx(over: Partial<AssembleContext> = {}): AssembleContext {
  return { memory: [], governanceDocs: [], ...over };
}

describe("assembleSystemPrompt — block order", () => {
  it("renders blocks in the CONTEXT-ENGINE §1 order", () => {
    const out = assembleSystemPrompt(
      baseCtx({
        platformInstructions: "platform rules",
        agentId: "sales",
        tenantId: "default",
        personality: "You are helpful.",
        memory: [mem("plan", "enterprise")],
        governanceDocs: [govDoc("Policy", "Be compliant.")],
      })
    );
    const order = [
      "<platform-instructions>",
      "<agent-identity>",
      "<agent-personality>",
      "<memory>",
      "<governance-knowledge>",
    ];
    const positions = order.map((tag) => out.indexOf(tag));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });
});

describe("assembleSystemPrompt — determinism (AC-V1-001)", () => {
  it("is byte-identical across calls with unchanged input", () => {
    const ctx = baseCtx({
      agentId: "sales",
      personality: "You are helpful.",
      memory: [mem("plan", "enterprise"), mem("tone", "terse")],
      governanceDocs: [govDoc("Policy", "Be compliant.")],
    });
    expect(assembleSystemPrompt(ctx)).toBe(assembleSystemPrompt(ctx));
  });

  it("is byte-identical for a structurally-equal second ctx object", () => {
    const a = assembleSystemPrompt(
      baseCtx({ agentId: "sales", memory: [mem("plan", "enterprise")] })
    );
    const b = assembleSystemPrompt(
      baseCtx({ agentId: "sales", memory: [mem("plan", "enterprise")] })
    );
    expect(a).toBe(b);
  });
});

describe("assembleSystemPrompt — platform-instructions", () => {
  it("emits the block when text is present and not skipped", () => {
    const out = assembleSystemPrompt(baseCtx({ platformInstructions: "rules" }));
    expect(out).toContain("<platform-instructions>\nrules\n</platform-instructions>");
  });

  it("omits block 1 when skipPlatformPrompt is true even with text", () => {
    const out = assembleSystemPrompt(
      baseCtx({ platformInstructions: "rules", skipPlatformPrompt: true })
    );
    expect(out).not.toContain("<platform-instructions>");
  });

  it("omits block 1 when no text is supplied", () => {
    const out = assembleSystemPrompt(baseCtx({ agentId: "x" }));
    expect(out).not.toContain("<platform-instructions>");
  });
});

describe("assembleSystemPrompt — agent-identity", () => {
  it("renders agentId, domain, and tenantId lines when present", () => {
    const out = assembleSystemPrompt(
      baseCtx({ agentId: "sales", domain: "crm", tenantId: "default" })
    );
    expect(out).toContain("<agent-identity>");
    expect(out).toContain("agentId: sales");
    expect(out).toContain("domain: crm");
    expect(out).toContain("tenantId: default");
  });

  it("omits absent identity fields and the block when fully empty", () => {
    const withOnlyAgent = assembleSystemPrompt(baseCtx({ agentId: "sales" }));
    expect(withOnlyAgent).toContain("agentId: sales");
    expect(withOnlyAgent).not.toContain("domain:");
    expect(withOnlyAgent).not.toContain("tenantId:");

    const empty = assembleSystemPrompt(baseCtx());
    expect(empty).not.toContain("<agent-identity>");
  });
});

describe("assembleSystemPrompt — agent-personality", () => {
  it("renders the AGENT.md body verbatim", () => {
    const out = assembleSystemPrompt(baseCtx({ personality: "You are a terse assistant." }));
    expect(out).toContain("<agent-personality>\nYou are a terse assistant.\n</agent-personality>");
  });

  it("omits the block when personality is empty", () => {
    expect(assembleSystemPrompt(baseCtx({ personality: "" }))).not.toContain("<agent-personality>");
    expect(assembleSystemPrompt(baseCtx())).not.toContain("<agent-personality>");
  });
});

describe("assembleSystemPrompt — memory", () => {
  it("renders one line per entry in listByUser order", () => {
    const out = assembleSystemPrompt(
      baseCtx({ memory: [mem("plan", "enterprise"), mem("tone", "terse")] })
    );
    expect(out).toContain("<memory>\n- plan: enterprise\n- tone: terse\n</memory>");
  });

  it("omits the block for empty memory", () => {
    expect(assembleSystemPrompt(baseCtx({ memory: [] }))).not.toContain("<memory>");
  });

  it("keeps the block at exactly MAX_TOTAL_CHARS, drops it one char over", () => {
    // budget = sum(key.length + value.length); "m" key = 1 char, so value pads to the boundary.
    const atCap = assembleSystemPrompt(baseCtx({ memory: [mem("m", "x".repeat(2047))] }));
    expect(atCap).toContain("<memory>");
    const overCap = assembleSystemPrompt(baseCtx({ memory: [mem("m", "x".repeat(2048))] }));
    expect(overCap).not.toContain("<memory>");
  });
});

describe("assembleSystemPrompt — governance", () => {
  it("renders the governance block via buildGovernanceBlock", () => {
    const out = assembleSystemPrompt(
      baseCtx({ governanceDocs: [govDoc("Policy", "Be compliant.")] })
    );
    expect(out).toContain("<governance-knowledge>");
    expect(out).toContain("## Policy");
    expect(out).toContain("Be compliant.");
  });

  it("omits the block when there are no governance docs", () => {
    expect(assembleSystemPrompt(baseCtx())).not.toContain("<governance-knowledge>");
  });

  it("stays tenant-wide regardless of the agent domain (display-only, AGT-V1-007)", () => {
    const tenantWide = govDoc("Tenant Policy", "Applies to all.");
    const crmScoped: KnowledgeDocument = { ...govDoc("CRM Policy", "CRM only."), domain: "crm" };
    const out = assembleSystemPrompt(
      baseCtx({ domain: "crm", governanceDocs: [tenantWide, crmScoped] })
    );
    // Domain feeds <agent-identity>, not governance scope: tenant-wide doc in, crm-scoped doc out.
    expect(out).toContain("## Tenant Policy");
    expect(out).not.toContain("## CRM Policy");
  });
});

describe("assembleSystemPrompt — available-skills (lazy L1)", () => {
  it("renders one `- name: description` line per skill, in given order", () => {
    const out = assembleSystemPrompt(
      baseCtx({
        availableSkills: [
          { name: "code-review", description: "Review code for bugs." },
          { name: "data-export", description: "Export resources to CSV." },
        ],
      })
    );
    expect(out).toContain(
      "<available-skills>\n- code-review: Review code for bugs.\n- data-export: Export resources to CSV.\n</available-skills>"
    );
  });

  it("renders just `- name` when a skill has no description", () => {
    const out = assembleSystemPrompt(
      baseCtx({ availableSkills: [{ name: "bare", description: "" }] })
    );
    expect(out).toContain("<available-skills>\n- bare\n</available-skills>");
  });

  it("omits the block when there are no skills (unset or empty)", () => {
    expect(assembleSystemPrompt(baseCtx())).not.toContain("<available-skills>");
    expect(assembleSystemPrompt(baseCtx({ availableSkills: [] }))).not.toContain(
      "<available-skills>"
    );
  });

  it("drops the whole block when over the char budget (never half-rendered)", () => {
    const huge = "x".repeat(9000);
    const out = assembleSystemPrompt(
      baseCtx({ availableSkills: [{ name: "big", description: huge }] })
    );
    expect(out).not.toContain("<available-skills>");
  });

  it("renders after <governance-knowledge> (CONTEXT-ENGINE §1 order)", () => {
    const out = assembleSystemPrompt(
      baseCtx({
        governanceDocs: [govDoc("Policy", "Be compliant.")],
        availableSkills: [{ name: "code-review", description: "Review code." }],
      })
    );
    expect(out.indexOf("<governance-knowledge>")).toBeLessThan(out.indexOf("<available-skills>"));
  });
});

describe("assembleSystemPrompt — skills (eager L2)", () => {
  it("renders a ## section per eager skill in <skills>", () => {
    const out = assembleSystemPrompt(
      baseCtx({
        eagerSkills: [
          { name: "code-review", body: "Review code carefully." },
          { name: "data-export", body: "Export to CSV." },
        ],
      })
    );
    expect(out).toContain(
      "<skills>\n## code-review\nReview code carefully.\n\n## data-export\nExport to CSV.\n</skills>"
    );
  });

  it("omits the block when eagerSkills is unset or empty", () => {
    expect(assembleSystemPrompt(baseCtx())).not.toContain("<skills>");
    expect(assembleSystemPrompt(baseCtx({ eagerSkills: [] }))).not.toContain("<skills>");
  });

  it("drops the whole block when over the char budget (never half-rendered)", () => {
    const out = assembleSystemPrompt(
      baseCtx({ eagerSkills: [{ name: "big", body: "x".repeat(33000) }] })
    );
    expect(out).not.toContain("<skills>");
  });

  it("renders before <available-skills> (CONTEXT-ENGINE §1 order)", () => {
    const out = assembleSystemPrompt(
      baseCtx({
        eagerSkills: [{ name: "eager", body: "eager body" }],
        availableSkills: [{ name: "lazy", description: "lazy desc" }],
      })
    );
    expect(out.indexOf("<skills>")).toBeLessThan(out.indexOf("<available-skills>"));
  });

  it("renders after <governance-knowledge> (CONTEXT-ENGINE §1 order)", () => {
    const out = assembleSystemPrompt(
      baseCtx({
        governanceDocs: [govDoc("Policy", "Be compliant.")],
        eagerSkills: [{ name: "eager", body: "eager body" }],
      })
    );
    expect(out.indexOf("<governance-knowledge>")).toBeLessThan(out.indexOf("<skills>"));
  });
});

describe("assembleSystemPrompt — deferred + typed-state (AC-V1-003)", () => {
  it("omits the still-deferred soul-context and tools blocks", () => {
    const out = assembleSystemPrompt(
      baseCtx({ agentId: "sales", memory: [mem("plan", "enterprise")] })
    );
    for (const tag of ["<soul-context>", "<available-tools>"]) {
      expect(out).not.toContain(tag);
    }
  });

  it("never emits a <harness-typed-state> block", () => {
    const out = assembleSystemPrompt(
      baseCtx({
        platformInstructions: "p",
        agentId: "sales",
        domain: "crm",
        tenantId: "default",
        personality: "p",
        memory: [mem("plan", "enterprise")],
        governanceDocs: [govDoc("Policy", "x")],
      })
    );
    expect(out).not.toContain("<harness-typed-state>");
  });

  it("returns an empty string when every block is empty", () => {
    expect(assembleSystemPrompt(baseCtx())).toBe("");
  });
});
