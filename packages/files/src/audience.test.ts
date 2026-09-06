import { describe, expect, it } from "vitest";
import { generatedAudience } from "./audience";
import { BUSINESS_PRINCIPAL_ID } from "./limits";

const BUSINESS = "biz";

describe("who may read a File an Agent just wrote", () => {
  it("is only the requester when no Agent is named", async () => {
    const audience = await generatedAudience(
      { businessId: BUSINESS, readableBy: { kind: "user", id: "asker" } },
      async () => ["never-asked"]
    );
    expect(audience).toEqual([{ kind: "user", id: "asker" }]);
  });

  it("adds the Roles the authoring Agent holds, and keeps the requester", async () => {
    // The requester's own share has to survive. Replacing it would mean asking an Agent that
    // happens to belong to a team for a document you then cannot open yourself.
    const audience = await generatedAudience(
      { businessId: BUSINESS, readableBy: { kind: "user", id: "asker" }, authoredByAgentId: "hr" },
      async (_businessId, principalId) => (principalId === "hr" ? ["hr-team", "payroll"] : [])
    );
    expect(audience).toEqual([
      { kind: "user", id: "asker" },
      { kind: "role", id: "hr-team" },
      { kind: "role", id: "payroll" },
    ]);
  });

  it("leaves an Agent that holds no Role behaving exactly as before", async () => {
    const audience = await generatedAudience(
      {
        businessId: BUSINESS,
        readableBy: { kind: "user", id: "asker" },
        authoredByAgentId: "solo",
      },
      async () => []
    );
    expect(audience).toEqual([{ kind: "user", id: "asker" }]);
  });

  it("shares nothing when nobody is named, rather than everything", async () => {
    expect(await generatedAudience({ businessId: BUSINESS }, async () => [])).toEqual([]);
  });

  it("never writes a share to the business that already owns the File", async () => {
    const audience = await generatedAudience(
      { businessId: BUSINESS, readableBy: { kind: "user", id: BUSINESS_PRINCIPAL_ID } },
      async () => []
    );
    expect(audience).toEqual([]);
  });

  it("names each grantee once when the requester also holds the Agent's Role", async () => {
    const audience = await generatedAudience(
      {
        businessId: BUSINESS,
        readableBy: { kind: "role", id: "hr-team" },
        authoredByAgentId: "hr",
      },
      async () => ["hr-team", "hr-team"]
    );
    expect(audience).toEqual([{ kind: "role", id: "hr-team" }]);
  });

  it("resolves no Roles at all when the deployment has no Role port", async () => {
    // Absent means no Role-based sharing, never "all Roles".
    const audience = await generatedAudience({
      businessId: BUSINESS,
      readableBy: { kind: "user", id: "asker" },
      authoredByAgentId: "hr",
    });
    expect(audience).toEqual([{ kind: "user", id: "asker" }]);
  });
});

describe("an unattended Run's audience", () => {
  it("falls back to the subject's own Roles when no human asked and the Agent holds none", async () => {
    // A scheduled Routine has no requester to share with, so without this the report is owned by
    // the business, shared with nobody, and unreachable by every human in the deployment.
    const audience = await generatedAudience(
      { businessId: BUSINESS, subjectPrincipalId: "routine-principal", authoredByAgentId: "hr" },
      async (_business, principal) => (principal === "routine-principal" ? ["eng-team"] : [])
    );
    expect(audience).toEqual([{ kind: "role", id: "eng-team" }]);
  });

  it("still names the Agent's Roles when both the Agent and the subject hold some", async () => {
    const audience = await generatedAudience(
      { businessId: BUSINESS, subjectPrincipalId: "routine-principal", authoredByAgentId: "hr" },
      async (_business, principal) => (principal === "hr" ? ["hr-team"] : ["eng-team"])
    );
    expect(audience).toEqual([
      { kind: "role", id: "hr-team" },
      { kind: "role", id: "eng-team" },
    ]);
  });

  it("ignores the subject's Roles when a person asked, so an interactive Run is unchanged", async () => {
    const audience = await generatedAudience(
      {
        businessId: BUSINESS,
        readableBy: { kind: "user", id: "asker" },
        subjectPrincipalId: "asker",
      },
      async () => ["everyone"]
    );
    expect(audience).toEqual([{ kind: "user", id: "asker" }]);
  });
});
