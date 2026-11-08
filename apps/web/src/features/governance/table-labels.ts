import { teamLabel } from './team-labels';

type Table = { id: string; name: string; owningTeamId: string };

// Tables can share a name, so collisions read as "Name · Owning team · short id", like the agent table picker.
export function tableLabels(tables: readonly Table[], teams: readonly { id: string; name: string }[]) {
  const counts = new Map<string, number>();
  for (const table of tables) {
    const key = table.name.trim().toLowerCase();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return new Map(
    tables.map(table => {
      if ((counts.get(table.name.trim().toLowerCase()) ?? 0) < 2) return [table.id, table.name];
      const owner = teams.find(team => team.id === table.owningTeamId);
      const team = owner ? teamLabel(owner.name) : `Team ${table.owningTeamId.slice(0, 8)}`;
      return [table.id, `${table.name} · ${team} · ${table.id.slice(0, 8)}`];
    }),
  );
}
