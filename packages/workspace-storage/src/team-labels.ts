const labels: Record<string, string> = { _admin: 'Admin', _everyone: 'Everyone' };

/** Internal teams are stored with a leading underscore; people and the agent see these names instead. */
export const teamLabel = (name: string) => labels[name] ?? name;
