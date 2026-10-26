import { randomUUID } from 'node:crypto';
import { createSkillImports } from '../src/skill-imports.ts';
import { createSkillObjects } from '../src/skill-objects.ts';

export function memorySkillBytes() {
  const bytes = new Map();
  return {
    async putIfAbsent(key, value) {
      if (!bytes.has(key)) bytes.set(key, Uint8Array.from(value));
    },
    async read(key) {
      if (!bytes.has(key)) throw new Error('missing-object');
      return bytes.get(key);
    },
    async remove(key) {
      bytes.delete(key);
    },
  };
}

/** Import service with a deterministic safety review, sharing the chat tools' byte store. */
export function skillDraftImports(runtime, bytes) {
  return createSkillImports(runtime, {
    objects: createSkillObjects(runtime, bytes),
    runtimeAvailable: () => false,
    review: () => async () => ({ summary: 'Fixture procedure with no findings.', findings: [] }),
  });
}

/** Runs the safety review for a chat-drafted package and returns the decision a human would approve. */
export async function reviewSkillDraft(imports, workspaceId, user, importId) {
  await imports.process(workspaceId, importId);
  const view = await imports.read(workspaceId, user, importId);
  if (view.status !== 'ready') throw new Error(`skill draft is ${view.status}, not ready`);
  return { commandId: randomUUID(), digest: view.digest, selected: view.selected, acknowledgeWarnings: true };
}
