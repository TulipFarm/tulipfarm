import { escapeIdentifier, escapeLiteral } from 'pg';
import { z } from 'zod';
import { inTransaction, type SqlClient } from '@tulipfarm/workspace-storage/provisioning';

const registrySchema = z.object({
  capability: z.enum(['authoring', 'confirmation', 'migration']),
  role: z.string().regex(/^[a-z][a-z0-9_]{0,62}$/),
  password: z.string().min(24),
});

async function repairRegistryDefaults(client: SqlClient, role: string) {
  const defaults = z.array(z.object({ creator: z.string(), schema: z.string().nullable() })).parse(
    (
      await client.query(
        `
    WITH affected AS (
      SELECT current_user AS creator, 'app'::text AS schema
      UNION SELECT pg_get_userbyid(d.defaclrole), n.nspname
      FROM pg_default_acl d LEFT JOIN pg_namespace n ON n.oid = d.defaclnamespace
      CROSS JOIN LATERAL aclexplode(d.defaclacl) acl
      WHERE d.defaclobjtype IN ('r', 'S', 'f')
        AND (acl.grantee = $1::regrole OR (acl.grantee = 0
          AND (d.defaclnamespace = 0 OR has_schema_privilege($1, n.oid, 'USAGE'))))
    ) SELECT creator, schema FROM affected UNION SELECT creator, NULL::text FROM affected`,
        [role],
      )
    ).rows,
  );
  for (const { creator, schema } of defaults) {
    const scope = schema === null ? '' : `IN SCHEMA ${escapeIdentifier(schema)}`;
    try {
      for (const objects of ['TABLES', 'SEQUENCES', 'ROUTINES']) {
        await client.query(`ALTER DEFAULT PRIVILEGES FOR ROLE ${escapeIdentifier(creator)} ${scope}
          REVOKE ALL ON ${objects} FROM ${escapeIdentifier(role)}, PUBLIC`);
      }
    } catch (cause) {
      throw new Error(`Cannot repair registry default privileges for creator ${creator}`, { cause });
    }
  }
}

async function verifyRegistryPrivileges(
  client: SqlClient,
  role: string,
  capability: z.infer<typeof registrySchema>['capability'],
  credential: string,
) {
  const violations = await client.query(
    `
    SELECT 'table' AS kind FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg_toast%'
      AND (c.relowner = $1::regrole OR (c.relkind IN ('r', 'p', 'v', 'm', 'f')
        AND has_table_privilege($1, c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'))
        OR (c.relkind = 'S' AND has_sequence_privilege($1, c.oid, 'USAGE,SELECT,UPDATE')))
    UNION ALL
    SELECT 'column' FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg_toast%'
      AND c.relkind IN ('r', 'p', 'v', 'm', 'f') AND a.attnum > 0 AND NOT a.attisdropped
      AND (has_column_privilege($1, c.oid, a.attnum, 'INSERT,UPDATE,REFERENCES,SELECT WITH GRANT OPTION')
        OR (has_column_privilege($1, c.oid, a.attnum, 'SELECT') AND NOT (n.nspname = 'app' AND (
          (c.relname = 'workspace_storage' AND a.attname = ANY($2::text[]))
          OR (c.relname = 'workspaces' AND a.attname = ANY($3::text[]))))))
    UNION ALL
    SELECT 'routine' FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
      AND (p.proowner = $1::regrole OR (has_schema_privilege($1, n.oid, 'USAGE') AND has_function_privilege($1, p.oid, 'EXECUTE')))
      AND NOT ($4 = 'authoring' AND p.oid = coalesce(to_regprocedure('app.acquire_knowledge_embedding_capacity(uuid,text,integer,uuid)'), 0::oid)
        AND p.proowner <> $1::regrole)
      AND NOT ($4 = 'authoring' AND p.oid=ANY(ARRAY[
        coalesce(to_regprocedure('app.workspace_member_profiles(uuid,uuid[])'),0::oid),
        coalesce(to_regprocedure('app.workspace_flag_context(uuid)'),0::oid),
        coalesce(to_regprocedure('app.pending_member_profile_events()'),0::oid),
        coalesce(to_regprocedure('app.advance_member_profile_event(uuid,bigint,uuid,uuid)'),0::oid),
        coalesce(to_regprocedure('app.register_model_bundle(text,jsonb)'),0::oid),
        coalesce(to_regprocedure('app.model_bundle(text)'),0::oid)
      ]) AND p.proowner=(SELECT nspowner FROM pg_namespace WHERE nspname='app')
        AND p.proconfig=ARRAY['search_path=pg_catalog']
        AND NOT has_function_privilege($1,p.oid,'EXECUTE WITH GRANT OPTION'))
    UNION ALL
    SELECT 'schema' FROM pg_namespace n WHERE has_schema_privilege($1, n.oid, 'CREATE')
    UNION ALL
    SELECT 'database' WHERE has_database_privilege($1, current_database(), 'CREATE,TEMPORARY')
    LIMIT 1`,
    [
      role,
      ['workspace_id', 'generation', 'stage', credential],
      capability === 'authoring' ? ['id', 'created_by', 'created_at', 'soul_commit', 'soul_bucket', 'soul_key'] : [],
      capability,
    ],
  );
  if (violations.rowCount) throw new Error('Registry login has ambient privileges outside its capability boundary');
}

/** Server model bundle registration and lookup, for the API (`tulipfarm`) and worker (authoring registry) logins. */
export const modelBundleRoutines = ['app.register_model_bundle(text,jsonb)', 'app.model_bundle(text)'] as const;

export async function grantTableRegistryAccess(
  client: SqlClient,
  role: string,
  capability: z.infer<typeof registrySchema>['capability'],
) {
  const name = escapeIdentifier(role);
  const credential = capability === 'authoring' ? 'runtime_credential' : `${capability}_credential`;
  await client.query(`GRANT USAGE ON SCHEMA app TO ${name}`);
  await client.query(
    `GRANT SELECT (workspace_id, generation, stage, ${escapeIdentifier(credential)}) ON app.workspace_storage TO ${name}`,
  );
  if (capability === 'authoring') {
    await client.query(
      `GRANT SELECT (id, created_by, created_at, soul_commit, soul_bucket, soul_key) ON app.workspaces TO ${name}`,
    );
    const embeddingCapacity = 'app.acquire_knowledge_embedding_capacity(uuid,text,integer,uuid)';
    if ((await client.query('SELECT to_regprocedure($1) AS routine', [embeddingCapacity])).rows[0]?.routine) {
      await client.query(`GRANT EXECUTE ON FUNCTION ${embeddingCapacity} TO ${name}`);
    }
    for (const signature of [
      'app.workspace_member_profiles(uuid,uuid[])',
      'app.workspace_flag_context(uuid)',
      'app.pending_member_profile_events()',
      'app.advance_member_profile_event(uuid,bigint,uuid,uuid)',
      ...modelBundleRoutines,
    ])
      if ((await client.query('SELECT to_regprocedure($1) AS routine', [signature])).rows[0]?.routine) {
        await client.query(`GRANT EXECUTE ON FUNCTION ${signature} TO ${name}`);
      }
  }
  return credential;
}

export async function provisionTableRegistry(client: SqlClient, input: z.input<typeof registrySchema>) {
  const { capability, role, password } = registrySchema.parse(input);
  const name = escapeIdentifier(role);
  const marker = `tulipfarm.table-registry.${capability}`;
  await inTransaction(client, async transaction => {
    await transaction.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 739))', [marker]);
    const existing = (
      await transaction.query(
        `SELECT shobj_description(oid, 'pg_authid') AS marker,
      rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls AS elevated
      FROM pg_roles WHERE rolname = $1`,
        [role],
      )
    ).rows[0];
    if (existing) {
      const row = z.object({ marker: z.string().nullable(), elevated: z.boolean() }).parse(existing);
      if (row.marker !== marker || row.elevated) throw new Error('Unexpected registry role');
    } else {
      await transaction.query(
        `CREATE ROLE ${name} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT`,
      );
      await transaction.query(`COMMENT ON ROLE ${name} IS ${escapeLiteral(marker)}`);
    }
    if ((await transaction.query('SELECT 1 FROM pg_auth_members WHERE member = $1::regrole', [role])).rowCount) {
      throw new Error('Registry login must not inherit another role');
    }
    const database = z
      .object({ name: z.string() })
      .parse((await transaction.query('SELECT current_database() AS name')).rows[0]).name;
    await transaction.query(`ALTER ROLE ${name} LOGIN NOINHERIT PASSWORD ${escapeLiteral(password)}`);
    await transaction.query(`ALTER ROLE ${name} SET search_path TO pg_catalog`);
    await transaction.query(`REVOKE ALL ON DATABASE ${escapeIdentifier(database)} FROM ${name}`);
    await transaction.query(`GRANT CONNECT ON DATABASE ${escapeIdentifier(database)} TO ${name}`);
    await transaction.query(`REVOKE ALL ON SCHEMA app FROM ${name}; GRANT USAGE ON SCHEMA app TO ${name}`);
    await repairRegistryDefaults(transaction, role);
    await transaction.query(`REVOKE ALL ON ALL TABLES IN SCHEMA app FROM ${name}`);
    await transaction.query(`REVOKE ALL ON ALL SEQUENCES IN SCHEMA app FROM ${name}`);
    await transaction.query(`REVOKE ALL ON ALL ROUTINES IN SCHEMA app FROM ${name}`);
    const columns = z.array(z.object({ relation: z.string(), column: z.string() })).parse(
      (
        await transaction.query(`SELECT c.relname AS relation, a.attname AS column
      FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'app' AND c.relkind IN ('r', 'p', 'v', 'm', 'f') AND a.attnum > 0 AND NOT a.attisdropped`)
      ).rows,
    );
    for (const column of columns)
      await transaction.query(
        `REVOKE ALL (${escapeIdentifier(column.column)}) ON app.${escapeIdentifier(column.relation)} FROM ${name}`,
      );
    const credential = await grantTableRegistryAccess(transaction, role, capability);
    await verifyRegistryPrivileges(transaction, role, capability, credential);
  });
}
