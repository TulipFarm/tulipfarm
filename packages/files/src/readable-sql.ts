import { qualified } from '@tulipfarm/workspace-storage/runtime';

export function readableFileSql(schema: string) {
  const files = qualified(schema, 'tf_files');
  return `EXISTS (WITH RECURSIVE lineage AS (
    SELECT f.id,f.parent_id,f.creator_membership_id,f.ready,f.trashed_at
    FROM ${files} f WHERE f.id=(r.original->>'fileId')::uuid
    UNION
    SELECT p.id,p.parent_id,p.creator_membership_id,p.ready,p.trashed_at
    FROM ${files} p JOIN lineage c ON p.id=c.parent_id
  ) SELECT 1 FROM ${files} original
  WHERE original.id=(r.original->>'fileId')::uuid AND original.kind='file'
    AND original.object_key IS NOT NULL AND original.sha256=r.original->>'sha256'
    AND original.size=(r.original->>'bytes')::bigint
    AND NOT EXISTS (SELECT 1 FROM lineage WHERE NOT ready OR trashed_at IS NOT NULL)
    AND (EXISTS (SELECT 1 FROM lineage WHERE creator_membership_id=$1)
      OR EXISTS (SELECT 1 FROM ${qualified(schema, 'tf_file_grants')} g JOIN lineage a ON a.id=g.item_id
        WHERE (g.subject_kind='individual' AND g.subject_id=$1)
          OR (g.subject_kind='team' AND EXISTS (SELECT 1 FROM ${qualified(schema, 'tf_member_teams')} mt
            JOIN ${qualified(schema, 'tf_teams')} t ON t.id=mt.team_id WHERE mt.membership_id=$1 AND mt.team_id=g.subject_id)))))`;
}
