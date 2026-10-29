# Keep the text a step writes before a tool call

## Problem

While a reply runs, the model sometimes writes a sentence and then calls a tool.
The chat shows that sentence live, then removes it. It is never saved, so a
reload shows nothing. The result is a flash of text that vanishes.

## Cause

- `packages/agents/src/inference.ts` keeps step text only in model context
  (`items.push({kind:'model', ...})`) and calls `preview('')` to clear it.
- `apps/web/src/features/chat/current-reply.ts` treats the text as narration
  and `private-conversations.tsx` shows it only while `thinking`.
- Nothing writes the text to the database.

## Approach

Save the text on the tool row of its step and show it as a grey note in the
activity list. Stop clearing it.

1. `packages/workspace-storage/common/0022_tool_call_narration.sql`: add
   nullable `narration text` to `tf_conversation_tool_calls`, length at most 2000.
2. `packages/agents/src/inference.ts`: pass the step text with each tool call
   and carry the text of steps that call only non-work tools onto the next work
   tool row.
3. `apps/worker/src/conversation-activities.ts` and
   `packages/conversations/src/runtime.ts`: thread the value like `activity`
   and write it in the tool row INSERT.
4. `packages/conversations/src/index.ts` and `contracts.ts`: return it in
   history. Return null when the tool result is hidden, with the same gates as
   `activity`.
5. `apps/web/src/features/chat/conversation-api.ts`, `tool-labels.tsx`,
   `current-reply.ts`, `private-conversations.tsx`: show it once per step. No
   second copy when the saved row arrives.
6. Tests, after the founder verifies the screen: `apps/web/test/current-reply.test.ts`
   and one saved-data assertion.

## Risks

- Narration can quote tool results such as mail or calendar text. It must obey
  the access-denied and `google.read` gates.
- Check retention and deletion against how tool rows are deleted today.
- Old rows have no note. This is fine.

## Open item

A first-step sentence with no tool call also vanished in one capture. The server
path that cleared it is not proven. Trace it before closing the work.
