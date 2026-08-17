import { describe, expect, it } from "vitest";
import { PROPOSAL_SUBJECT_KINDS, RESOURCE_TEMPLATES } from "./proposal";
import { soulSubjects, soulSummary } from "./soul-view";

type SoulSlice = Parameters<typeof soulSubjects>[0];

function soul(overrides: Partial<Record<keyof SoulSlice, unknown>> = {}): SoulSlice {
  return {
    resources: new Map(),
    agents: new Map(),
    skills: new Map(),
    integrations: new Map(),
    routines: new Map(),
    manifest: null,
    ...overrides,
  } as unknown as SoulSlice;
}

describe("soulSubjects", () => {
  it("only ever emits kinds a Proposal can name", () => {
    const subjects = soulSubjects(
      soul({
        resources: new Map([["ticket", { displayName: "Ticket" }]]),
        agents: new Map([["triage", { name: "Triage" }]]),
        integrations: new Map([["github", { title: "GitHub" }]]),
        skills: new Map([["writing", { displayName: "Writing" }]]),
        routines: new Map([["nightly", { displayName: "Nightly" }]]),
      })
    );
    for (const subject of subjects) {
      expect(PROPOSAL_SUBJECT_KINDS).toContain(subject.kind);
    }
  });

  it("excludes Skills and Routines, which no proposal kind takes as a subject", () => {
    const subjects = soulSubjects(
      soul({
        skills: new Map([["writing", { displayName: "Writing" }]]),
        routines: new Map([["nightly", { displayName: "Nightly" }]]),
      })
    );
    expect(subjects.map((s) => s.id)).not.toContain("writing");
    expect(subjects.map((s) => s.id)).not.toContain("nightly");
  });

  it("reads a display name from Soul, falling back to the id", () => {
    const subjects = soulSubjects(
      soul({
        agents: new Map([
          ["triage", { displayName: "Triage bot" }],
          ["nameless", {}],
        ]),
      })
    );
    expect(subjects.find((s) => s.id === "triage")?.label).toBe("Triage bot");
    expect(subjects.find((s) => s.id === "nameless")?.label).toBe("nameless");
  });

  it("offers the Resource templates that do not exist yet, and no others", () => {
    const subjects = soulSubjects(soul({ resources: new Map([["tickets", { name: "Tickets" }]]) }));
    const templates = subjects.filter((s) => s.kind === "resource_template").map((s) => s.id);
    expect(templates).not.toContain("tickets");
    expect(templates).toContain("leads");
    expect(templates).toHaveLength(Object.keys(RESOURCE_TEMPLATES).length - 1);
  });

  it("never labels a template from model-adjacent text", () => {
    const subjects = soulSubjects(soul());
    expect(subjects.find((s) => s.id === "leads")?.label).toBe(RESOURCE_TEMPLATES.leads);
  });
});

describe("soulSummary", () => {
  it("names the business and what it has built", () => {
    const summary = soulSummary(
      soul({
        manifest: { businessName: "Acme", businessDescription: "We ship widgets" },
        agents: new Map([
          ["triage", {}],
          ["billing", {}],
        ]),
      })
    );
    expect(summary).toContain("Name: Acme");
    expect(summary).toContain("We ship widgets");
    expect(summary).toContain("agents: billing, triage");
    expect(summary).toContain("resource types: (none)");
  });

  it("stays readable when the Soul has no manifest at all", () => {
    expect(soulSummary(soul())).toContain("(unnamed business)");
  });
});
