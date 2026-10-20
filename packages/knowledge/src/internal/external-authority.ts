import { z } from 'zod';
import { AccessDenied, type AuthorizationTransaction, type HumanActor } from '@tulipfarm/access';
import { qualified } from '@tulipfarm/workspace-storage/runtime';
import { KnowledgeError } from './contracts.ts';
import type { ExternalSource } from './store.ts';

type Authority = {
  requireExternalSource: (tx: AuthorizationTransaction, actor: HumanActor, source: ExternalSource) => Promise<void>;
  requireExternalProof: (tx: AuthorizationTransaction, actor: HumanActor, documentId: string) => Promise<void>;
};

const families = {
  google: 'google',
  slack: 'slack',
  github: 'github',
  confluence: 'atlassian',
  jira: 'atlassian',
} as const;
async function installed(tx: AuthorizationTransaction, name: string) {
  return z
    .object({ installed: z.boolean() })
    .parse(
      (await tx.client.query('SELECT to_regclass($1) IS NOT NULL AS installed', [qualified(tx.schema, name)])).rows[0],
    ).installed;
}

// Reads the same reader and eligibility relations as each provider adapter, without
// constructing provider clients. Missing relations fail closed without aborting SQL.
export function sqlExternalAuthority(): Authority {
  return {
    async requireExternalSource(tx, actor, source) {
      const family = families[source.provider as keyof typeof families];
      const name = family && `tf_knowledge_${family}_readers`;
      if (!name || !(await installed(tx, name))) throw new AccessDenied();
      if (
        !(
          await tx.client.query(
            `SELECT 1 FROM ${qualified(tx.schema, name)} WHERE source_id=$1 AND membership_id=$2 AND user_id=$3`,
            [source.id, actor.membershipId, actor.userId],
          )
        ).rowCount
      )
        throw new AccessDenied();
    },
    async requireExternalProof(tx, actor, documentId) {
      const row = z
        .object({ provider: z.string() })
        .optional()
        .parse(
          (
            await tx.client.query(
              `SELECT s.provider FROM ${qualified(tx.schema, 'tf_knowledge_documents')} d
        JOIN ${qualified(tx.schema, 'tf_knowledge_sources')} s ON s.id=d.source_id WHERE d.id=$1`,
              [documentId],
            )
          ).rows[0],
        );
      const family = row && families[row.provider as keyof typeof families];
      const name = family && `tf_knowledge_${family}_eligible`;
      if (!name || !(await installed(tx, name))) throw new KnowledgeError('permission-expired');
      if (
        !(
          await tx.client.query(
            `SELECT 1 FROM ${qualified(tx.schema, name)} WHERE document_id=$1 AND membership_id=$2 AND user_id=$3`,
            [documentId, actor.membershipId, actor.userId],
          )
        ).rowCount
      )
        throw new KnowledgeError('permission-expired');
    },
  };
}

// Dispatches external source and proof checks to the adapter that owns each provider.
export function externalAuthority(
  adapters: Partial<Record<'google' | 'slack' | 'github' | 'confluence' | 'jira', { authority: Authority }>>,
) {
  const entries = Object.entries(adapters).flatMap(([provider, adapter]) =>
    adapter ? [[provider, adapter.authority] as const] : [],
  );
  const fallback = sqlExternalAuthority();
  if (!entries.length) return fallback;
  const owners = new Map<string, Authority>(entries);
  return {
    async requireExternalSource(tx: AuthorizationTransaction, actor: HumanActor, source: ExternalSource) {
      const owner = owners.get(source.provider);
      if (!owner) return fallback.requireExternalSource(tx, actor, source);
      await owner.requireExternalSource(tx, actor, source);
    },
    async requireExternalProof(tx: AuthorizationTransaction, actor: HumanActor, documentId: string) {
      const row = z
        .object({ provider: z.string() })
        .optional()
        .parse(
          (
            await tx.client.query(
              `SELECT s.provider FROM ${qualified(tx.schema, 'tf_knowledge_documents')} d
        JOIN ${qualified(tx.schema, 'tf_knowledge_sources')} s ON s.id=d.source_id WHERE d.id=$1`,
              [documentId],
            )
          ).rows[0],
        );
      const owner = row && owners.get(row.provider);
      if (!owner) return fallback.requireExternalProof(tx, actor, documentId);
      await owner.requireExternalProof(tx, actor, documentId);
    },
  };
}
