import { z } from 'zod';
import {
  auditedPgvectorFunctions,
  pgvectorExtensionFunctions,
  qualified,
  workspaceNames,
  type SqlClient,
} from '@tulipfarm/workspace-storage/provisioning';
import { releaseLogins, releaseRoleSchema, StorageReleaseError } from './storage-release.ts';

export async function inspectProvisionerWorkspaces(client: SqlClient, provisioner: string = releaseLogins[0].role) {
  releaseRoleSchema.parse(provisioner);
  const schemas = z
    .array(z.object({ schema: z.string(), owner: z.string() }))
    .parse(
      (
        await client.query(
          "SELECT nspname AS schema, pg_get_userbyid(nspowner) AS owner FROM pg_namespace WHERE nspname ~ '^ws_' ORDER BY nspname LIMIT 1001",
        )
      ).rows,
    );
  if (schemas.length > 1000) throw new StorageReleaseError('Storage release validation is limited to 1000 workspaces.');
  const scopes = [];
  for (const { schema, owner } of schemas) {
    if (!/^ws_[a-f0-9]{32}$/.test(schema) || owner !== provisioner) {
      throw new StorageReleaseError('Workspace storage requires an explicit schema ownership handoff.');
    }
    const receipt = z
      .object({ workspace_id: z.uuid() })
      .parse(
        (await client.query(`SELECT workspace_id FROM ${qualified(schema, 'tf_provisioning')} WHERE id=1`)).rows[0],
      );
    const names = workspaceNames(receipt.workspace_id);
    if (names.schema !== schema) throw new StorageReleaseError('Workspace admission does not match its schema.');
    const roles = [names.runtime, names.migration, names.confirmation, names.customOwner];
    const rows = z
      .array(
        z.object({ rolname: z.string(), marker: z.string().nullable(), elevated: z.boolean(), login: z.boolean() }),
      )
      .parse(
        (
          await client.query(
            `SELECT rolname, shobj_description(oid, 'pg_authid') AS marker,
       rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls OR rolinherit AS elevated,
       rolcanlogin AS login FROM pg_roles WHERE rolname=ANY($1::text[])`,
            [roles],
          )
        ).rows,
      );
    if (
      rows.length !== 4 ||
      rows.some(
        row =>
          row.elevated ||
          row.marker !== `tulipfarm.workspace.${names.workspaceId}` ||
          row.login !== (row.rolname !== names.customOwner),
      )
    )
      throw new StorageReleaseError('Unexpected workspace role attributes or marker.');
    const memberships = z.array(z.object({ valid: z.boolean() })).parse(
      (
        await client.query(
          `SELECT
      (child.rolname=$2 AND parent.rolname=$3 AND NOT m.admin_option AND NOT m.inherit_option AND m.set_option
        AND m.grantor=$4::regrole) AS valid FROM pg_auth_members m JOIN pg_roles parent ON parent.oid=m.roleid
      JOIN pg_roles child ON child.oid=m.member WHERE child.rolname=ANY($1::text[])`,
          [roles, names.migration, names.customOwner, owner],
        )
      ).rows,
    );
    if (memberships.length !== 1 || memberships.some(row => !row.valid))
      throw new StorageReleaseError('Missing or unexpected workspace role membership.');
    scopes.push(names);
  }
  const unknown = await client.query(
    `WITH RECURSIVE held(role) AS (
      SELECT oid FROM pg_roles WHERE rolname=$2 UNION SELECT m.roleid FROM held JOIN pg_auth_members m ON m.member=held.role
    ) SELECT 1 FROM pg_roles r WHERE r.rolname ~ '^ws_' AND NOT (r.rolname=ANY($1::text[])) AND
      (r.oid IN (SELECT role FROM held) OR EXISTS (SELECT 1 FROM pg_shdepend d
        WHERE d.refclassid='pg_authid'::regclass AND d.refobjid=r.oid AND
        (d.dbid=(SELECT oid FROM pg_database WHERE datname=current_database()) OR
          (d.dbid=0 AND d.classid='pg_database'::regclass AND d.objid=(SELECT oid FROM pg_database WHERE datname=current_database()))))) LIMIT 1`,
    [scopes.flatMap(scope => [scope.runtime, scope.migration, scope.confirmation, scope.customOwner]), provisioner],
  );
  if (unknown.rowCount) throw new StorageReleaseError('Workspace role has no validated schema admission.');
  return scopes;
}

export async function inspectProvisionerAccess(
  client: SqlClient,
  scopes: Awaited<ReturnType<typeof inspectProvisionerWorkspaces>>,
  provisioner: string = releaseLogins[0].role,
) {
  releaseRoleSchema.parse(provisioner);
  const roles = scopes.flatMap(scope => [scope.runtime, scope.migration, scope.confirmation, scope.customOwner]);
  const pgvectorFunctions = await auditedPgvectorFunctions(client);
  const pgvectorExtension = await pgvectorExtensionFunctions(client);
  const owners = scopes.map(scope => scope.customOwner);
  const schemas = scopes.map(scope => scope.schema);
  const memberships = z.array(z.object({ role: z.string(), creator: z.boolean(), owner: z.boolean() })).parse(
    (
      await client.query(
        `SELECT parent.rolname AS role,
      (m.admin_option AND NOT m.inherit_option AND NOT m.set_option AND m.grantor=10 AND grantor.rolsuper) AS creator,
      (NOT m.admin_option AND m.inherit_option AND m.set_option AND m.grantor=m.member) AS owner
    FROM pg_auth_members m JOIN pg_roles parent ON parent.oid=m.roleid JOIN pg_roles grantor ON grantor.oid=m.grantor
    WHERE m.member=$1::regrole`,
        [provisioner],
      )
    ).rows,
  );
  if (
    memberships.length !== roles.length + owners.length ||
    roles.some(role => memberships.filter(row => row.role === role && row.creator).length !== 1) ||
    owners.some(role => memberships.filter(row => row.role === role && row.owner).length !== 1)
  ) {
    throw new StorageReleaseError('Storage release login has missing or unexpected role membership or options.');
  }
  for (const principal of [provisioner, ...owners]) {
    const ownScope = scopes.find(scope => scope.customOwner === principal);
    const allowedSchemas = ownScope ? [ownScope.schema] : schemas;
    const violations = await client.query(
      `WITH relations AS (
      SELECT c.*, n.nspname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%'
        AND NOT (n.nspname=ANY($2::text[]))
    ) SELECT 'table' AS kind FROM relations c
      CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN']) p
      WHERE c.relkind IN ('r','p','v','m','f') AND has_table_privilege($1,c.oid,p) AND NOT ($3 AND
        ((c.nspname='app' AND ((c.relname='workspaces' AND p='SELECT')
          OR (c.relname='workspace_storage' AND p IN ('SELECT','UPDATE'))
          OR (c.relname='workspace_storage_operations' AND p IN ('SELECT','INSERT'))))
          OR (c.nspname='database_management' AND c.relname IN ('common_target','common_rollouts') AND c.relowner=$1::regrole)))
    UNION ALL SELECT 'column' FROM relations c JOIN pg_attribute a ON a.attrelid=c.oid
      CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','REFERENCES']) p
      WHERE c.relkind IN ('r','p','v','m','f') AND a.attnum>0 AND NOT a.attisdropped
        AND has_column_privilege($1,c.oid,a.attnum,p) AND NOT ($3 AND
        ((c.nspname='app' AND ((c.relname='workspaces' AND (p='SELECT' OR (p='UPDATE' AND a.attname IN ('soul_commit','soul_bucket','soul_key','ready_at'))))
          OR (c.relname='workspace_storage' AND p IN ('SELECT','UPDATE'))
          OR (c.relname='workspace_storage_operations' AND p IN ('SELECT','INSERT'))))
          OR (c.nspname='database_management' AND c.relname IN ('common_target','common_rollouts') AND c.relowner=$1::regrole)))
    UNION ALL SELECT 'table delegation' FROM relations c
      CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN']) p
      WHERE c.relkind IN ('r','p','v','m','f') AND has_table_privilege($1,c.oid,p || ' WITH GRANT OPTION')
        AND NOT ($3 AND c.nspname='database_management' AND c.relname IN ('common_target','common_rollouts') AND c.relowner=$1::regrole)
    UNION ALL SELECT 'column delegation' FROM relations c JOIN pg_attribute a ON a.attrelid=c.oid
      CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','REFERENCES']) p
      WHERE c.relkind IN ('r','p','v','m','f') AND a.attnum>0 AND NOT a.attisdropped
        AND has_column_privilege($1,c.oid,a.attnum,p || ' WITH GRANT OPTION')
        AND NOT ($3 AND c.nspname='database_management' AND c.relname IN ('common_target','common_rollouts') AND c.relowner=$1::regrole)
    UNION ALL SELECT 'sequence' FROM relations c WHERE CASE WHEN c.relkind='S' THEN has_sequence_privilege($1,c.oid,'USAGE,SELECT,UPDATE') ELSE false END
    UNION ALL SELECT 'ownership' FROM relations c WHERE c.relowner=$1::regrole AND NOT
      ($3 AND c.nspname='database_management' AND c.relname IN ('common_target','common_rollouts','common_target_pkey','common_rollouts_pkey'))
    UNION ALL SELECT 'routine' FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND NOT (n.nspname=ANY($2::text[]))
        AND (p.proowner=$1::regrole OR (has_schema_privilege($1,n.oid,'USAGE') AND has_function_privilege($1,p.oid,'EXECUTE')))
        AND NOT ($3 AND p.oid=ANY($4::oid[]) AND p.proowner<>$1::regrole)
        AND NOT (p.oid=ANY($5::oid[]) AND NOT has_function_privilege($1,p.oid,'EXECUTE WITH GRANT OPTION'))
        AND NOT ($3 AND p.oid='app.invitation_delivery(uuid,uuid,text,jsonb,timestamptz)'::regprocedure
          AND p.proowner=(SELECT nspowner FROM pg_namespace WHERE nspname='app') AND p.proowner<>$1::regrole)
        AND NOT COALESCE(($3 AND p.oid IN (to_regprocedure('app.workspace_access(uuid,boolean)'), to_regprocedure('app.workspace_settings(uuid,uuid,uuid,jsonb)'), to_regprocedure('app.model_availability_receipt()'))
          AND p.proowner=(SELECT nspowner FROM pg_namespace WHERE nspname='app') AND p.proowner<>$1::regrole), false)
    UNION ALL SELECT 'schema' FROM pg_namespace n WHERE n.nspname NOT IN ('pg_catalog','information_schema')
      AND NOT (n.nspname=ANY($2::text[])) AND (n.nspowner=$1::regrole OR has_schema_privilege($1,n.oid,'CREATE'))
      AND NOT ($3 AND n.nspname='database_management')
    UNION ALL SELECT 'schema delegation' FROM pg_namespace n WHERE n.nspname NOT IN ('pg_catalog','information_schema')
       AND NOT (n.nspname=ANY($2::text[])) AND has_schema_privilege($1,n.oid,'USAGE WITH GRANT OPTION,CREATE WITH GRANT OPTION')
        AND NOT ($3 AND n.nspname='app' AND NOT has_schema_privilege($1,n.oid,'CREATE WITH GRANT OPTION'))
        AND NOT ($3 AND n.nspname='extensions' AND NOT has_schema_privilege($1,n.oid,'CREATE WITH GRANT OPTION'))
    UNION ALL SELECT 'database' FROM pg_database d WHERE
      (d.datdba=$1::regrole OR has_database_privilege($1,d.oid,'CREATE') OR (d.datname=current_database() AND has_database_privilege($1,d.oid,'TEMPORARY')))
      AND NOT ($3 AND d.datname=current_database() AND d.datdba<>$1::regrole AND NOT has_database_privilege($1,d.oid,'TEMPORARY'))
    UNION ALL SELECT 'database delegation' FROM pg_database d WHERE has_database_privilege($1,d.oid,'CREATE WITH GRANT OPTION,TEMPORARY WITH GRANT OPTION')
    LIMIT 1`,
      [principal, allowedSchemas, principal === provisioner, pgvectorFunctions, pgvectorExtension],
    );
    if (violations.rowCount)
      throw new StorageReleaseError('Provisioner has unexpected object privileges or ownership.');
  }
  const defaults = await client.query(
    `SELECT 1 FROM pg_default_acl d LEFT JOIN pg_namespace n ON n.oid=d.defaclnamespace
    CROSS JOIN LATERAL aclexplode(d.defaclacl) a
    WHERE ((a.grantee=ANY(SELECT oid FROM pg_roles WHERE rolname=ANY($1::text[]))
      AND a.grantee<>d.defaclrole)
      OR (a.grantee=0 AND (d.defaclnamespace=0 OR EXISTS (SELECT 1 FROM pg_roles r
        WHERE r.rolname=ANY($1::text[]) AND has_schema_privilege(r.oid,n.oid,'USAGE'))))
      OR (d.defaclrole=ANY(SELECT oid FROM pg_roles WHERE rolname=ANY($1::text[])) AND a.grantee<>d.defaclrole))
      AND NOT COALESCE((pg_get_userbyid(d.defaclrole)=ANY($2::text[]) AND
        n.nspname=regexp_replace(pg_get_userbyid(d.defaclrole),'_owner$','') AND
        pg_get_userbyid(a.grantee)=n.nspname || '_runtime' AND NOT a.is_grantable AND
        ((d.defaclobjtype='r' AND a.privilege_type IN ('SELECT','INSERT','UPDATE','DELETE'))
          OR (d.defaclobjtype='S' AND a.privilege_type IN ('USAGE','SELECT')))), false) LIMIT 1`,
    [[provisioner, ...owners], owners],
  );
  if (defaults.rowCount) throw new StorageReleaseError('Provisioner has unexpected default privileges.');
}
