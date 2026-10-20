import { escapeIdentifier, escapeLiteral } from 'pg';
import { z } from 'zod';
import { inTransaction, type SqlClient } from '@tulipfarm/workspace-storage/provisioning';
import { ProductReleaseError, productEmailRole } from './product-release.ts';

const marker = 'tulipfarm.product-release.email-delivery.v1';
const roleSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,62}$/)
  .refine(value => !/^(pg_|ws_)/.test(value));

export async function inspectEmailLogin(client: SqlClient, role = productEmailRole): Promise<'absent' | 'retained'> {
  roleSchema.parse(role);
  if (!(await client.query("SELECT to_regclass('app.email_deliveries') AS relation")).rows[0]?.relation) {
    throw new ProductReleaseError('Email delivery migration is required before login preparation.');
  }
  const rows = await client.query(
    `SELECT shobj_description(oid, 'pg_authid') AS marker,
    rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls OR rolinherit OR NOT rolcanlogin AS elevated
    FROM pg_roles WHERE rolname=$1`,
    [role],
  );
  if (!rows.rows.length) return 'absent';
  const row = z.object({ marker: z.string().nullable(), elevated: z.boolean() }).parse(rows.rows[0]);
  if (row.marker !== marker || row.elevated)
    throw new ProductReleaseError('Unexpected or elevated existing email role. Refusing changes.');
  if (
    (
      await client.query(
        `SELECT 1 FROM pg_auth_members m JOIN pg_roles grantor ON grantor.oid=m.grantor
    WHERE (m.member=$1::regrole OR m.roleid=$1::regrole) AND NOT
      (m.roleid=$1::regrole AND m.member=current_user::regrole AND m.admin_option
        AND NOT m.inherit_option AND NOT m.set_option AND m.grantor=10 AND grantor.rolsuper)`,
        [role],
      )
    ).rowCount
  ) {
    throw new ProductReleaseError('Email role has unexpected memberships.');
  }
  const violations = await client.query(
    `WITH relations AS (
    SELECT c.*, n.nspname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%'
  ) SELECT 'table' AS kind FROM relations c
    CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN']) p
    WHERE c.relkind IN ('r','p','v','m','f') AND has_table_privilege($1,c.oid,p)
      AND NOT (c.nspname='app' AND c.relname='email_deliveries' AND p IN ('SELECT','UPDATE'))
  UNION ALL SELECT 'column' FROM relations c JOIN pg_attribute a ON a.attrelid=c.oid
    CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','REFERENCES']) p
    WHERE c.relkind IN ('r','p','v','m','f') AND a.attnum>0 AND NOT a.attisdropped
      AND has_column_privilege($1,c.oid,a.attnum,p)
      AND NOT (c.nspname='app' AND c.relname='email_deliveries' AND p IN ('SELECT','UPDATE'))
  UNION ALL SELECT 'delegation' FROM relations c JOIN pg_attribute a ON a.attrelid=c.oid
    CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','REFERENCES']) p
    WHERE c.relkind IN ('r','p','v','m','f') AND a.attnum>0 AND NOT a.attisdropped
      AND has_column_privilege($1,c.oid,a.attnum,p || ' WITH GRANT OPTION')
  UNION ALL SELECT 'ownership' FROM relations c WHERE c.relowner=$1::regrole
  UNION ALL SELECT 'sequence' FROM relations c WHERE CASE WHEN c.relkind='S' THEN has_sequence_privilege($1,c.oid,'USAGE,SELECT,UPDATE') ELSE false END
  UNION ALL SELECT 'routine' FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname NOT IN ('pg_catalog','information_schema')
      AND (p.proowner=$1::regrole OR (has_schema_privilege($1,n.oid,'USAGE') AND has_function_privilege($1,p.oid,'EXECUTE')))
  UNION ALL SELECT 'schema' FROM pg_namespace n WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%'
    AND (n.nspowner=$1::regrole OR has_schema_privilege($1,n.oid,'CREATE,USAGE WITH GRANT OPTION'))
  UNION ALL SELECT 'database' FROM pg_database d WHERE d.datdba=$1::regrole
    OR has_database_privilege($1,d.oid,'CREATE') OR (d.datname=current_database()
      AND has_database_privilege($1,d.oid,'TEMPORARY,CONNECT WITH GRANT OPTION'))
  UNION ALL SELECT 'other database grant' FROM pg_database d CROSS JOIN LATERAL aclexplode(d.datacl) a
    WHERE a.grantee=$1::regrole AND d.datname<>current_database()
  UNION ALL SELECT 'parameter' FROM pg_parameter_acl p CROSS JOIN LATERAL aclexplode(p.paracl) a
    WHERE a.grantee IN (0,$1::regrole)
  UNION ALL SELECT 'defaults' FROM pg_default_acl d CROSS JOIN LATERAL aclexplode(d.defaclacl) a
    WHERE a.grantee IN (0,$1::regrole) OR d.defaclrole=$1::regrole
  LIMIT 1`,
    [role],
  );
  if (violations.rowCount) throw new ProductReleaseError('Email role has unexpected object privileges or defaults.');
  const required = await client.query(
    `SELECT has_database_privilege($1,current_database(),'CONNECT')
    AND has_schema_privilege($1,'app','USAGE') AND has_table_privilege($1,'app.email_deliveries','SELECT')
    AND has_table_privilege($1,'app.email_deliveries','UPDATE') AS valid`,
    [role],
  );
  if (required.rows[0]?.valid !== true)
    throw new ProductReleaseError('Email role is missing required grants. Refusing implicit repair.');
  return 'retained';
}

export async function createEmailLogin(client: SqlClient, password: string, role = productEmailRole) {
  roleSchema.parse(role);
  z.string().min(24).parse(password);
  await inTransaction(client, async transaction => {
    await transaction.query('SELECT pg_advisory_xact_lock(734128, 3)');
    if ((await inspectEmailLogin(transaction, role)) !== 'absent')
      throw new ProductReleaseError('Email role already exists. No password or grant changes permitted.');
    const quoted = escapeIdentifier(role);
    const database = z
      .object({ name: z.string() })
      .parse((await transaction.query('SELECT current_database() AS name')).rows[0]).name;
    await transaction.query(
      `CREATE ROLE ${quoted} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD ${escapeLiteral(password)}`,
    );
    await transaction.query(`COMMENT ON ROLE ${quoted} IS ${escapeLiteral(marker)}`);
    await transaction.query(`ALTER ROLE ${quoted} SET search_path TO pg_catalog`);
    await transaction.query(`GRANT CONNECT ON DATABASE ${escapeIdentifier(database)} TO ${quoted}`);
    await transaction.query(`GRANT USAGE ON SCHEMA app TO ${quoted}`);
    await transaction.query(`GRANT SELECT, UPDATE ON app.email_deliveries TO ${quoted}`);
    await inspectEmailLogin(transaction, role);
  });
}

export async function encryptedProductKeyIds(client: SqlClient) {
  await client.query('SET row_security = off');
  const email: string[] = [];
  const integration: string[] = [];
  const relations = z
    .array(z.object({ schema: z.string(), name: z.enum(['email_deliveries', 'tf_integrations', 'tf_invitations']) }))
    .parse(
      (
        await client.query(`SELECT n.nspname AS schema,c.relname AS name
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind IN ('r','p') AND
    ((n.nspname='app' AND c.relname='email_deliveries') OR (n.nspname ~ '^ws_[a-f0-9]{32}$' AND
      (c.relname='tf_integrations' OR (c.relname='tf_invitations' AND EXISTS (
        SELECT 1 FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attname='copy_material' AND a.attnum>0 AND NOT a.attisdropped)))))`)
      ).rows,
    );
  for (const relation of relations) {
    const column = escapeIdentifier(
      { email_deliveries: 'payload', tf_integrations: 'credential', tf_invitations: 'copy_material' }[relation.name],
    );
    const ids = z.array(z.object({ id: z.string().min(1) })).parse(
      (
        await client.query(`SELECT DISTINCT ${column}->>'keyId' AS id
      FROM ${escapeIdentifier(relation.schema)}.${escapeIdentifier(relation.name)} WHERE ${column} IS NOT NULL`)
      ).rows,
    );
    (relation.name === 'tf_integrations' ? integration : email).push(...ids.map(row => row.id));
  }
  return { email, integration };
}
