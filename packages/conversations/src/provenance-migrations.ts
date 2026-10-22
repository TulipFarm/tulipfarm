import { fileURLToPath } from 'node:url';
import { migrationTarget, readMigrations, type Migration } from '@tulipfarm/workspace-storage/provisioning';

export async function projectProvenanceMigrations(existing: readonly Migration[]) {
  if (!existing.some(migration => migration.name === '0001_baseline.sql'))
    throw new Error('Project provenance requires 0001_baseline.sql');
  const stream = [
    ...existing,
    ...(await readMigrations(fileURLToPath(new URL('../provenance/', import.meta.url)))),
  ].sort((a, b) => a.name.localeCompare(b.name));
  migrationTarget(stream);
  return stream;
}
