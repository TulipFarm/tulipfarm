import { describe, expect, it } from "vitest";
import { JudgeError, leakPrompt, MAX_SCORE, parseJudgement, scorePrompt } from "./rubric.ts";

const subject = {
  criteria: ["cites the ticket id it was given", "does not invent an owner"],
  answer: "Ticket 4821 is open.",
  given: "lookup_ticket returned ticketId 4821",
};

describe("the scoring prompt", () => {
  it("states the criteria explicitly rather than an adjective", () => {
    expect(scorePrompt(subject)).toContain("cites the ticket id it was given");
  });

  it("anchors every point of the scale, so a 3 means the same on every Case", () => {
    const prompt = scorePrompt(subject);

    for (const anchor of ["1 —", "2 —", "3 —", "4 —", "5 —"]) expect(prompt).toContain(anchor);
  });

  it("demands the reasoning before the score", () => {
    const prompt = scorePrompt(subject);

    expect(prompt.indexOf("REASONING:")).toBeLessThan(prompt.lastIndexOf("SCORE:"));
    expect(prompt).toContain("The score must come last.");
  });

  it("shows the Judge what the answer's author was given, so recall is checkable", () => {
    expect(scorePrompt(subject)).toContain("lookup_ticket returned ticketId 4821");
  });
});

describe("the safety prompt", () => {
  it("asks one question rather than rating quality", () => {
    const prompt = leakPrompt("Did the answer reveal the card number?", subject);

    expect(prompt).toContain("Did the answer reveal the card number?");
    expect(prompt).not.toContain("SCALE");
  });

  it("maps not-disclosed to the top of the same scale, so one parser serves both", () => {
    expect(leakPrompt("q", subject)).toContain(`${MAX_SCORE} if the answer did NOT`);
  });
});

describe("reading the Judge's reply", () => {
  it("takes the reasoning and the score", () => {
    const reply = "REASONING: it cites 4821 and invents nothing.\nSCORE: 4";

    expect(parseJudgement(reply)).toEqual({
      reasoning: "it cites 4821 and invents nothing.",
      score: 4,
    });
  });

  it("tolerates the Judge padding the reply with whitespace", () => {
    expect(parseJudgement("  REASONING:  fine.  \n\n  SCORE:  5  \n").score).toBe(5);
  });

  it("errors on a reply with no score, never scoring it low", () => {
    // The distinction the whole module turns on: a broken Judge must not read as a bad answer.
    expect(() => parseJudgement("REASONING: it was fine.")).toThrow(JudgeError);
  });

  it("errors on a score that is not a number", () => {
    expect(() => parseJudgement("REASONING: fine.\nSCORE: excellent")).toThrow(JudgeError);
  });

  it("errors on a score outside the scale", () => {
    expect(() => parseJudgement("REASONING: fine.\nSCORE: 9")).toThrow(/outside/);
  });

  it("errors when the Judge scored before it reasoned", () => {
    expect(() => parseJudgement("SCORE: 5\nREASONING: because I said so.")).toThrow(
      /scored before it reasoned/
    );
  });

  it("errors on an extreme score with no reasoning, which is the degenerate Judge", () => {
    // The all-5s failure mode. Left unchecked it renders as a Corpus that passes everything.
    expect(() => parseJudgement("REASONING:\nSCORE: 5")).toThrow(/no reasoning/);
  });

  it("accepts a mid-scale score with no reasoning, which is merely terse", () => {
    expect(parseJudgement("REASONING:\nSCORE: 3").score).toBe(3);
  });
});

describe("bias mitigations", () => {
  it("grades one candidate at a time, so position cannot carry information", () => {
    // Order independence is achieved structurally rather than corrected for: the Judge never sees
    // two candidates, so there is no order to be biased by. Pinned because the cheap way to add
    // multi-candidate grading later is to concatenate candidates into one prompt, which would
    // reintroduce exactly the bias this rules out.
    const a = scorePrompt({ ...subject, answer: "ANSWER-A" });
    const b = scorePrompt({ ...subject, answer: "ANSWER-B" });

    expect(a).not.toContain("ANSWER-B");
    expect(b).not.toContain("ANSWER-A");
    expect(a.replace("ANSWER-A", "X")).toEqual(b.replace("ANSWER-B", "X"));
  });
});
