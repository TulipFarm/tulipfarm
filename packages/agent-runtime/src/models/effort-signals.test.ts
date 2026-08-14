import { describe, expect, it } from "vitest";
import { EFFORT_SIGNALS, promptFeatures } from "./effort-signals";

function fired(prompt: string): string[] {
  const features = promptFeatures(prompt);
  return EFFORT_SIGNALS.filter((signal) => signal.test(features)).map((signal) => signal.name);
}

describe("promptFeatures", () => {
  it("strips fenced code out of the prose it hands to keyword signals", () => {
    const features = promptFeatures("fix this\n```\nconst architecture = 1;\n```\n");
    expect(features.prose).not.toContain("architecture");
    expect(features.hasCodeBlock).toBe(true);
  });

  it("counts an unterminated fence as a code block", () => {
    expect(promptFeatures("look:\n```ts\nconst a = 1;").hasCodeBlock).toBe(true);
  });

  it("counts questions, numbered items, and bullets", () => {
    const features = promptFeatures("1. a\n2. b\n- x\n- y\n- z\nwhy? how?");
    expect(features.questionCount).toBe(2);
    expect(features.numberedItems).toBe(2);
    expect(features.bulletItems).toBe(3);
  });
});

describe("EFFORT_SIGNALS", () => {
  it("has unique names", () => {
    const names = EFFORT_SIGNALS.map((signal) => signal.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("keeps every weight on the 0.5 grid so scores stay exact in binary", () => {
    for (const signal of EFFORT_SIGNALS) {
      expect(signal.weight * 2).toBe(Math.trunc(signal.weight * 2));
      expect(signal.weight).not.toBe(0);
    }
  });

  it.each([
    ["greeting_or_ack", "thanks!"],
    ["greeting_or_ack", "go ahead"],
    ["simple_lookup", "what is the capital of France?"],
    ["simple_lookup", "how many users signed up yesterday?"],
    ["simple_lookup", "list my resources"],
    ["short_prompt", "refactor this"],
    ["long_prompt", `x${"y".repeat(400)}`],
    ["very_long_prompt", `x${"y".repeat(1_200)}`],
    ["multi_question", "should we cache? or should we not?"],
    ["platform_keywords", "connect the Slack integration to a routine"],
    ["multi_step", "1. read the file\n2. change it"],
    ["multi_step", "- a\n- b\n- c"],
    ["multi_step", "do the migration and then verify it"],
    ["code_block", "look\n```js\nconst a = 1;\n```"],
    ["code_block", "look\n    const a = 1;\n    const b = 2;"],
    ["design_keywords", "what are the tradeoffs of sharding here"],
    ["design_keywords", "compare these two approaches for me"],
  ])("%s fires on %j", (name, prompt) => {
    expect(fired(prompt)).toContain(name);
  });

  it.each([
    ["greeting_or_ack", "yes, but only after you check the migration plan"],
    ["simple_lookup", `what is the best way to ${"scale this system ".repeat(20)}`],
    ["short_prompt", "a".repeat(200)],
    ["multi_step", "then again, maybe not"],
    ["multi_question", "why?"],
    ["code_block", "use the `map` function"],
    ["design_keywords", "designate a new owner"],
  ])("%s does not fire on %j", (name, prompt) => {
    expect(fired(prompt)).not.toContain(name);
  });

  it("does not read a keyword out of pasted code", () => {
    expect(fired("run this\n```\nconst tradeoffs = designArchitecture();\n```")).not.toContain(
      "design_keywords"
    );
  });
});
