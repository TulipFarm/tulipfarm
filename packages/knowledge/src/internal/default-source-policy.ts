import type { AuthorizationTransaction } from '@tulipfarm/access';
import { qualified } from '@tulipfarm/workspace-storage/runtime';
import { KnowledgeError } from './contracts.ts';

export async function assertDefaultSourceEnabled(tx: AuthorizationTransaction, sourceId: string) {
  const table = (name: string) => qualified(tx.schema, `tf_knowledge_${name}`);
  const refused = await tx.client.query(
    `SELECT 1 FROM ${table('default_sources')} d JOIN ${table('default_intents')} i ON i.id=d.intent_id
    WHERE d.source_id=$1 AND (i.state<>'active' OR d.state='failed')`,
    [sourceId],
  );
  if (refused.rowCount) throw new KnowledgeError('conflict');
}
