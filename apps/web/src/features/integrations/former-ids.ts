// Old links and stored chat cards still name the integration by its former id.
const formerIds: Record<string, string> = { 'github-personal': 'github' };
export const currentIntegrationId = (id: string) => formerIds[id] ?? id;
