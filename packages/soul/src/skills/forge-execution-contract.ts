export const FORGE_EXECUTION_CONTRACT_TOKEN = "{{FORGE_EXECUTION_CONTRACT}}";

/**
 * Shared execution discipline expanded into every bundled forge Skill at boot. Keeping one source
 * avoids drift while the on-disk SKILL.md files remain readable and explicit about the include.
 */
export const FORGE_EXECUTION_CONTRACT = `## Execution Contract

- Inspect relevant existing Soul artifacts before writing, then use the creation or update tool that
  actually performs the requested change. Do not stop at a plan, draft, or preview.
- Treat a write as incomplete until it has a real tool result. Verify it with the relevant read,
  list, schema, status, or smoke-test tool when one is available.
- If validation or a tool call fails, use the returned error to correct the artifact and retry when
  the path is clear. If the request is genuinely blocked, report the specific blocker; never claim
  an artifact was created, activated, or tested when it was not.
- Keep dependent work ordered: inspect before changing, create prerequisites before dependants, and
  verify after changing. Batch independent inspection calls when the tool surface allows it.
- Respect the user's explicit approval choice and the active autonomy/approval controls. Ask one
  focused question only when the missing decision materially changes the artifact.`;

export function expandForgeExecutionContract(content: string): string {
  return content.replaceAll(FORGE_EXECUTION_CONTRACT_TOKEN, FORGE_EXECUTION_CONTRACT);
}
