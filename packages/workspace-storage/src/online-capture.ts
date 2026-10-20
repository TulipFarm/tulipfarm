import { escapeLiteral } from 'pg';
import { z } from 'zod';
import { qualified } from './names.ts';
import type { SqlClient } from './transactions.ts';

export function onlineCaptureBody(schema: string, source: string, dirty: string) {
  z.string()
    .regex(/^ws_[a-f0-9]{32}$/)
    .parse(schema);
  z.string()
    .regex(/^r_[a-f0-9]{32}$/)
    .parse(source);
  z.string()
    .regex(/^on_d_[a-f0-9]{32}$/)
    .parse(dirty);
  return `
BEGIN
  IF TG_TABLE_SCHEMA <> ${escapeLiteral(schema)} OR TG_TABLE_NAME <> ${escapeLiteral(source)} THEN
    RAISE EXCEPTION 'inactive-table-generation';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.id <> NEW.id THEN
    RAISE EXCEPTION 'record-identity-immutable';
  END IF;
  INSERT INTO ${qualified(schema, dirty)} (id, version)
    VALUES (CASE WHEN TG_OP = 'DELETE' THEN OLD.id ELSE NEW.id END, 1)
    ON CONFLICT (id) DO UPDATE SET version = ${qualified(schema, dirty)}.version + 1;
  RETURN NULL;
END
`;
}

export async function auditedOnlineCaptureFunctions(client: SqlClient, schema: string, owner: string) {
  const functions = z.array(z.object({ oid: z.number(), proname: z.string(), prosrc: z.string() })).parse(
    (
      await client.query(
        `
    SELECT p.oid, p.proname, p.prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    JOIN pg_language l ON l.oid=p.prolang
    WHERE n.nspname=$1 AND p.proowner=$2::regrole AND p.proname ~ '^on_f_[a-f0-9]{32}$'
      AND p.prosecdef AND p.prorettype='pg_catalog.trigger'::regtype AND p.pronargs=0
      AND p.proconfig=ARRAY['search_path=pg_catalog'] AND l.lanname='plpgsql'
      AND p.provolatile='v' AND NOT p.proleakproof AND NOT p.proisstrict AND NOT p.proretset`,
        [schema, owner],
      )
    ).rows,
  );
  return functions
    .filter(fn => {
      const source = /TG_TABLE_NAME <> '(r_[a-f0-9]{32})'/.exec(fn.prosrc)?.[1];
      return (
        source !== undefined && fn.prosrc === onlineCaptureBody(schema, source, fn.proname.replace('on_f_', 'on_d_'))
      );
    })
    .map(fn => fn.oid);
}
