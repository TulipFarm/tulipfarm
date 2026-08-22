import type { ExposedTool } from "@tulipfarm/agent-runtime";
import { FILE_TOOLS } from "@tulipfarm/files";
import {
  GITHUB_REPOSITORY_LIST_DECLARATION,
  GITHUB_TOOL_DECLARATIONS,
  SLACK_TOOL_DECLARATIONS,
} from "@tulipfarm/integrations";
import { NETWORK_TOOL_DECLARATIONS, SKILL_MARKETPLACE_TOOL_DECLARATIONS } from "@tulipfarm/schema";
import { SKILL_REFERENCE_TOOL_DECLARATIONS } from "@tulipfarm/soul";
import type { EvalCase } from "./case.ts";

/**
 * Platform Tools a Case may put in front of the model as they actually ship.
 *
 * Every other Tool in the Corpus is hand-declared inside its Case, which is right for a Tool that
 * stands in for something an operator would author. It is wrong for a Tool the product ships: a
 * hand-copied declaration goes stale silently, and the Case then measures the model against a
 * description no deployment has ever sent. Worse, the interesting properties here are properties
 * of the declaration — that `file_create` takes no owner, that its description tells the model not
 * to repeat the document — and a copy cannot assert them.
 *
 * So a Case names the Tool and gets the shipped object. Removing or renaming one fails the Corpus
 * load rather than quietly leaving a Case asserting nothing.
 */
const SHIPPED: readonly ExposedTool[] = [
  ...FILE_TOOLS,
  ...SKILL_MARKETPLACE_TOOL_DECLARATIONS,
  ...SKILL_REFERENCE_TOOL_DECLARATIONS,
  GITHUB_REPOSITORY_LIST_DECLARATION,
  ...GITHUB_TOOL_DECLARATIONS,
  ...SLACK_TOOL_DECLARATIONS,
  ...NETWORK_TOOL_DECLARATIONS,
].map((tool) => ({
  name: tool.name,
  description: tool.description,
  inputSchema: tool.inputSchema as ExposedTool["inputSchema"],
  ...(!("mutating" in tool) || tool.mutating === undefined ? {} : { mutating: tool.mutating }),
}));

const BY_NAME: ReadonlyMap<string, ExposedTool> = new Map(SHIPPED.map((tool) => [tool.name, tool]));

export function platformToolNames(): readonly string[] {
  return [...BY_NAME.keys()].sort();
}

/** The shipped declaration, or `undefined` so the caller can name the Case that asked for it. */
export function resolvePlatformTool(name: string): ExposedTool | undefined {
  return BY_NAME.get(name);
}

/**
 * Every Tool this Case puts in front of the model: its own declarations, then the shipped ones.
 *
 * An unresolvable name yields nothing rather than throwing, because `loadCorpus` already refuses
 * one — a second refusal here would be a check that can only fire when the first was bypassed.
 */
export function exposedToolsFor(evalCase: EvalCase): readonly ExposedTool[] {
  return [
    ...(evalCase.tools ?? []),
    ...(evalCase.platformTools ?? []).flatMap((name) => {
      const tool = resolvePlatformTool(name);
      return tool === undefined ? [] : [tool];
    }),
  ];
}
