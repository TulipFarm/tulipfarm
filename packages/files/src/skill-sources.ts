import {
  AccessDenied,
  SourceAuthorizationUnavailable,
  protectedSourceClosure,
  requireProtectedSource,
  sourceDependenciesSchema,
  type AuthorizationTransaction,
  type HumanActor,
} from '@tulipfarm/access';
import { qualified } from '@tulipfarm/workspace-storage/runtime';

const installed = new WeakMap<AuthorizationTransaction, boolean>();
const visiting = new WeakMap<AuthorizationTransaction, Set<string>>();

export async function requireSkillFileSources(
  tx: AuthorizationTransaction,
  actor: HumanActor,
  fileId: string,
  read: (tx: AuthorizationTransaction, actor: HumanActor, fileId: string) => Promise<unknown>,
) {
  const table = qualified(tx.schema, 'tf_file_skill_sources');
  if (!installed.has(tx))
    installed.set(
      tx,
      Boolean((await tx.client.query('SELECT to_regclass($1) IS NOT NULL AS installed', [table])).rows[0]?.installed),
    );
  if (!installed.get(tx)) return;
  const row = (await tx.client.query(`SELECT sources FROM ${table} WHERE file_id=$1`, [fileId])).rows[0];
  if (!row) return;
  const stack = visiting.get(tx) ?? new Set<string>();
  const key = `${actor.membershipId}/${fileId}`;
  if (stack.has(key)) return;
  if (stack.size >= 100) throw new AccessDenied();
  visiting.set(tx, stack);
  stack.add(key);
  try {
    const bound: AuthorizationTransaction = {
      ...tx,
      requireTulipFarmFile: async (human, reference) => {
        await read(tx, human, reference.fileId);
      },
    };
    for (const source of await protectedSourceClosure(bound, sourceDependenciesSchema.parse(row.sources)))
      await requireProtectedSource(bound, actor, source);
  } finally {
    stack.delete(key);
  }
}

export async function visibleSkillFiles<T extends { id: string }>(
  tx: AuthorizationTransaction,
  actor: HumanActor,
  rows: readonly T[],
  read: (tx: AuthorizationTransaction, actor: HumanActor, fileId: string) => Promise<unknown>,
) {
  const visible: T[] = [];
  for (const row of rows) {
    try {
      await requireSkillFileSources(tx, actor, row.id, read);
      visible.push(row);
    } catch (error) {
      if (!(error instanceof AccessDenied) || error instanceof SourceAuthorizationUnavailable) throw error;
    }
  }
  return visible;
}
