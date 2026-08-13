import { describe, expect, test } from "vitest";
import { buildDirectory, lookupParty, matchesQuery } from "./access-directory";
import type { UserSummary } from "./users";

const PRIYA: UserSummary = {
  id: "0b925e15-881b-4f76-ac0d-f5d6e4f41b40",
  email: "priya@cafe.test",
  name: "Priya Sharma",
  role: "member",
  status: "active",
};

const UNNAMED: UserSummary = {
  id: "6c1f0a2e-1111-4222-8333-944455556666",
  email: "rahul@cafe.test",
  name: null,
  role: "member",
  status: "invited",
};

const directory = buildDirectory([PRIYA, UNNAMED]);

describe("lookupParty", () => {
  /*
   * The join this module exists for. `principal_id = users.id::text` is written by the
   * `sync_user_authorization` trigger, and nothing on the access screens used it — which is why
   * every member row was a raw UUID.
   */
  test("resolves a principal id to the person's name and email", () => {
    const party = lookupParty(directory, PRIYA.id);
    expect(party.name).toBe("Priya Sharma");
    expect(party.detail).toBe("priya@cafe.test");
    expect(party.isPerson).toBe(true);
    expect(party.initials).toBe("PS");
  });

  test("falls back to the email when nobody has set a name", () => {
    // Names are self-authored, so an invited account legitimately has none. Guessing one from the
    // email would look authored and be wrong.
    const party = lookupParty(directory, UNNAMED.id);
    expect(party.name).toBe("rahul@cafe.test");
    expect(party.detail).toBe("rahul@cafe.test");
  });

  test("names a kind-prefixed principal without pretending it is a person", () => {
    const party = lookupParty(directory, "service:billing-api");
    expect(party.name).toBe("Billing api");
    expect(party.detail).toBe("Service — not a person");
    expect(party.isPerson).toBe(false);
  });

  /*
   * An access holder we cannot name still has to render. Hiding it would leave authority on the
   * books that no screen accounts for, which is strictly worse than an ugly row.
   */
  test("still renders a principal it knows nothing about", () => {
    const party = lookupParty(directory, "aabbccddeeff00112233");
    expect(party.isPerson).toBe(false);
    expect(party.name).toBe("aabbccdd…");
    expect(party.principalId).toBe("aabbccddeeff00112233");
  });

  test("keeps the exact id available even when the display name is shortened", () => {
    expect(lookupParty(directory, PRIYA.id).principalId).toBe(PRIYA.id);
  });
});

describe("matchesQuery", () => {
  const priya = lookupParty(directory, PRIYA.id);

  test.each([["priya"], ["PRIYA"], ["Sharma"], ["cafe.test"], [""]])("%j matches", (query) => {
    expect(matchesQuery(priya, query)).toBe(true);
  });

  test("still matches on the raw id, for an operator holding one from a log", () => {
    expect(matchesQuery(priya, "0b925e15")).toBe(true);
  });

  test("does not match an unrelated term", () => {
    expect(matchesQuery(priya, "rahul")).toBe(false);
  });
});
