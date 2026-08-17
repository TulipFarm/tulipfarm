import { MEMORY_SECTION_KEYS } from "@tulipfarm/schema";
import { describe, expect, it } from "vitest";
import { buildBusinessCuratorPrompt, buildUserCuratorPrompt } from "./prompt";
import { PROPOSAL_KINDS, RESOURCE_TEMPLATES } from "./proposal";

const input = {
  memoryDocument: "## Identity\n\n- Lives in Bangalore\n",
  sectionCharsRemaining: { identity: 5_800 },
  turns: [{ turnId: "t1", userText: "I moved to Pune", assistantText: "Noted." }],
  subjects: [{ kind: "resource_type", id: "tickets", label: "Support Tickets" }],
  openProposalKeys: ["curator:create_agent_for_resource:resource_type:tickets"],
  seeds: [{ id: "s1", rationale: "GitHub was just connected" }],
};

describe("buildUserCuratorPrompt", () => {
  // The prompt and the validator share one vocabulary so the rules the model is given cannot
  // drift from the rules the server enforces. A section the model is never told about is a
  // section it will never write to.
  it("names every section and every proposal kind", () => {
    const prompt = buildUserCuratorPrompt(input);
    for (const key of MEMORY_SECTION_KEYS) expect(prompt).toContain(key);
    for (const kind of PROPOSAL_KINDS) expect(prompt).toContain(kind);
    for (const id of Object.keys(RESOURCE_TEMPLATES)) expect(prompt).toContain(id);
  });

  it("carries the pinned state the model reasons over", () => {
    const prompt = buildUserCuratorPrompt(input);
    expect(prompt).toContain("Lives in Bangalore");
    expect(prompt).toContain('<turn id="t1">');
    expect(prompt).toContain("I moved to Pune");
    expect(prompt).toContain("resource_type tickets: Support Tickets");
    expect(prompt).toContain("GitHub was just connected");
  });

  // A section with no room left must still be listed, or the model would read its absence as
  // "this section does not exist" rather than "this section is full".
  it("states the remaining room for every section, including the ones it was not told about", () => {
    const prompt = buildUserCuratorPrompt(input);
    expect(prompt).toContain("identity: 5800 characters left");
    expect(prompt).toContain("preferences: 0 characters left");
  });

  it("tells the model what is already open so it does not repeat itself", () => {
    expect(buildUserCuratorPrompt(input)).toContain(
      "curator:create_agent_for_resource:resource_type:tickets"
    );
  });

  it("reads sensibly when there is nothing to reason over", () => {
    const empty = buildUserCuratorPrompt({
      memoryDocument: "",
      sectionCharsRemaining: {},
      turns: [],
      subjects: [],
      openProposalKeys: [],
      seeds: [],
    });
    expect(empty).toContain("(empty)");
    expect(empty).toContain("(no new conversation)");
    expect(empty).toContain("(none yet)");
  });
});

describe("buildBusinessCuratorPrompt", () => {
  const prompt = buildBusinessCuratorPrompt({
    soulSummary: "Acme ships developer tools.",
    candidates: [{ id: "c1", statement: "The team releases on Thursdays" }],
  });

  it("carries the business state and its candidates", () => {
    expect(prompt).toContain("Acme ships developer tools.");
    expect(prompt).toContain("c1: The team releases on Thursdays");
  });

  // The business pass aggregates several people, so it must never be told it can name one — the
  // prompt has to agree with a schema that cannot express an audience.
  it("says it has no audience and no memory to write", () => {
    expect(prompt).toContain("cannot write to any individual's memory");
    expect(prompt).not.toContain("knowledgePromotions");
    for (const key of MEMORY_SECTION_KEYS) expect(prompt).not.toContain(key);
  });
});
