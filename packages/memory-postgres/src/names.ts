import { escapeIdentifier } from 'pg';

export type PostgresMemoryNames = { schema: string; tablePrefix: string };

export function memoryTable(names: PostgresMemoryNames, name: string) {
  return `${escapeIdentifier(names.schema)}.${escapeIdentifier(`${names.tablePrefix}${name}`)}`;
}
