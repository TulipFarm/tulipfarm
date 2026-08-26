import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  putSkillDraft,
  resetSkillDrafts,
  type SkillDraft,
  skillBodyDigest,
  takeSkillDraft,
} from "./drafts";

function draft(name = "code-review"): SkillDraft {
  return {
    kind: "create",
    name,
    version: "1.0.0",
    body: "Review code.",
    frontmatter: { name, description: "Review code." },
    content: `---\nname: ${name}\n---\nReview code.`,
  };
}

describe("skill drafts", () => {
  beforeEach(() => {
    resetSkillDrafts();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns the parked draft verbatim", () => {
    const parked = draft();
    expect(takeSkillDraft(putSkillDraft(parked))).toEqual(parked);
  });

  // A token records one human decision. Replaying it would turn a single approval into standing
  // permission to write the same Skill again.
  it("spends a token exactly once", () => {
    const token = putSkillDraft(draft());
    expect(takeSkillDraft(token)).toBeDefined();
    expect(takeSkillDraft(token)).toBeUndefined();
  });

  it("reports nothing for a token it never issued", () => {
    expect(takeSkillDraft("not-a-token")).toBeUndefined();
  });

  // An approval must not be bankable: a Soul reviewed ten minutes ago is not the Soul being
  // written to now.
  it("refuses a token older than the draft lifetime", () => {
    vi.useFakeTimers();
    const token = putSkillDraft(draft());
    vi.advanceTimersByTime(10 * 60 * 1000 + 1);
    expect(takeSkillDraft(token)).toBeUndefined();
  });

  it("keeps a token inside the draft lifetime", () => {
    vi.useFakeTimers();
    const token = putSkillDraft(draft());
    vi.advanceTimersByTime(9 * 60 * 1000);
    expect(takeSkillDraft(token)).toBeDefined();
  });

  // A Turn that audits over and over without confirming must not be able to grow the store.
  it("evicts the oldest drafts past its capacity", () => {
    const first = putSkillDraft(draft("first"));
    for (let i = 0; i < 40; i++) putSkillDraft(draft(`filler-${i}`));
    expect(takeSkillDraft(first)).toBeUndefined();
  });

  it("digests bodies so a changed base is detectable", () => {
    expect(skillBodyDigest("a")).toBe(skillBodyDigest("a"));
    expect(skillBodyDigest("a")).not.toBe(skillBodyDigest("b"));
  });
});
