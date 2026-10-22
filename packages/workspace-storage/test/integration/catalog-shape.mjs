// A workspace schema's catalog with its generated names written as placeholders, so two workspaces compare structurally.
// Business table storage (g_<id>) is per-workspace data, not schema history, so it is left out.
export async function catalogShape(client, names) {
  const schema = names.schema;
  const local = value =>
    value === null || value === undefined
      ? value
      : String(value)
          .replaceAll(`"${schema}"`, '{{schema}}')
          .replaceAll(schema, '{{schema}}')
          .replace(/storage_owner_[0-9a-f]{32}/g, '{{owner}}');
  const rows = async sql =>
    (await client.query(sql, [schema])).rows
      .filter(row => !Object.values(row).some(value => /(^|\.)g_[0-9a-f]{32}/.test(String(value))))
      .map(row => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, local(value)])));
  return {
    relations:
      await rows(`SELECT c.relname, c.relkind, c.relrowsecurity, c.relforcerowsecurity, c.reloptions::text options, c.relacl::text acl
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relkind IN ('r','p','v','m','S','i') ORDER BY 1`),
    columns:
      await rows(`SELECT c.relname, a.attnum, a.attname, format_type(a.atttypid, a.atttypmod) type, a.attnotnull, pg_get_expr(d.adbin, d.adrelid) "default", a.attacl::text acl
      FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
      WHERE n.nspname = $1 AND a.attnum > 0 AND NOT a.attisdropped AND c.relkind IN ('r','p','v','m') ORDER BY 1, 2`),
    constraints: await rows(`SELECT conrelid::regclass::text rel, conname, pg_get_constraintdef(oid) def, convalidated
      FROM pg_constraint WHERE connamespace = (SELECT oid FROM pg_namespace WHERE nspname = $1) ORDER BY 1, 2`),
    indexes: await rows(`SELECT indexname, tablename, indexdef FROM pg_indexes WHERE schemaname = $1 ORDER BY 1`),
    functions:
      await rows(`SELECT p.proname, pg_get_function_identity_arguments(p.oid) args, pg_get_functiondef(p.oid) def, p.proacl::text acl
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = $1 ORDER BY 1, 2`),
    triggers: await rows(`SELECT t.tgrelid::regclass::text rel, t.tgname, pg_get_triggerdef(t.oid) def, t.tgenabled
      FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND NOT t.tgisinternal ORDER BY 1, 2`),
    views: await rows(`SELECT viewname, definition FROM pg_views WHERE schemaname = $1 ORDER BY 1`),
    policies: await rows(
      `SELECT tablename, policyname, permissive, roles::text, cmd, qual, with_check FROM pg_policies WHERE schemaname = $1 ORDER BY 1, 2`,
    ),
  };
}
