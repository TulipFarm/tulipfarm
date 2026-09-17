import { expect, test } from "vitest";
import { chatLaunchFromState } from "./launch";

test("only a complete Plan-mode launch is accepted from navigation state", () => {
  const launch = { id: "pack-1", mode: "plan", prompt: "Original YAML" };
  expect(chatLaunchFromState({ chatLaunch: launch })).toEqual(launch);
  for (const state of [
    null,
    {},
    { chatLaunch: { ...launch, prompt: "" } },
    { chatLaunch: { ...launch, mode: "act" } },
    { chatLaunch: { ...launch, id: undefined } },
  ]) {
    expect(chatLaunchFromState(state)).toBeUndefined();
  }
});
