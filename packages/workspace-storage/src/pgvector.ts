import { escapeIdentifier } from 'pg';
import { z } from 'zod';
import type { SqlClient } from './transactions.ts';

const signatures = [
  'extensions.vector_in(cstring,oid,integer)',
  'extensions.vector_out(extensions.vector)',
  'extensions.vector_typmod_in(cstring[])',
  'extensions.vector(extensions.vector,integer,boolean)',
  'extensions.cosine_distance(extensions.vector,extensions.vector)',
];

export async function auditedPgvectorFunctions(client: SqlClient) {
  const installed =
    await client.query(`SELECT 1 FROM pg_catalog.pg_extension e JOIN pg_catalog.pg_namespace n ON n.oid=e.extnamespace
    WHERE e.extname='vector' AND n.nspname='extensions' AND pg_catalog.string_to_array(e.extversion,'.')::int[] >= ARRAY[0,8,0]`);
  if (!installed.rowCount) return [];
  const rows = z.array(z.object({ oid: z.number().int() })).parse(
    (
      await client.query(
        `SELECT p.oid FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_depend d ON d.classid='pg_catalog.pg_proc'::regclass AND d.objid=p.oid AND d.deptype='e'
    JOIN pg_catalog.pg_extension e ON d.refclassid='pg_catalog.pg_extension'::regclass AND d.refobjid=e.oid
    JOIN pg_catalog.pg_language l ON l.oid=p.prolang
    WHERE e.extname='vector' AND p.pronamespace=e.extnamespace AND NOT p.prosecdef
      AND l.lanname='c' AND p.probin='$libdir/vector'
      AND p.prosrc=p.proname AND p.provolatile='i' AND p.proisstrict AND p.proparallel='s'
      AND p.oid=ANY(SELECT pg_catalog.to_regprocedure(signature)::oid FROM unnest($1::text[]) signature)`,
        [signatures],
      )
    ).rows,
  );
  if (rows.length !== signatures.length) throw new Error('Unexpected pgvector function definitions');
  return rows.map(row => row.oid);
}

export async function pgvectorExtensionFunctions(client: SqlClient) {
  if (!(await auditedPgvectorFunctions(client)).length) return [];
  const rows = z.array(z.object({ oid: z.number().int() })).parse(
    (
      await client.query(`SELECT p.oid FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_depend d ON d.classid='pg_catalog.pg_proc'::regclass AND d.objid=p.oid AND d.deptype='e'
    JOIN pg_catalog.pg_extension e ON d.refclassid='pg_catalog.pg_extension'::regclass AND d.refobjid=e.oid
    WHERE e.extname='vector' AND p.pronamespace=e.extnamespace AND NOT p.prosecdef`)
    ).rows,
  );
  return rows.map(row => row.oid);
}

export async function grantPgvector(client: SqlClient, role: string, delegate = false) {
  if (!(await auditedPgvectorFunctions(client)).length)
    throw new Error('Provision pgvector >= 0.8.0 in extensions before workspace rollout');
  const recipient = `${escapeIdentifier(role)}${delegate ? ' WITH GRANT OPTION' : ''}`;
  await client.query(`GRANT USAGE ON SCHEMA extensions TO ${recipient}`);
  await client.query(`GRANT USAGE ON TYPE extensions.vector TO ${recipient}`);
  await client.query(`GRANT EXECUTE ON FUNCTION ${signatures.join(',')} TO ${recipient}`);
}
