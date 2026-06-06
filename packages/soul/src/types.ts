export interface SoulAgent {
  name: string;
  frontmatter: Record<string, unknown>;
  body: string;
}

export interface SoulSkill {
  name: string;
  frontmatter: Record<string, unknown>;
  body: string;
}

export interface SoulResource {
  name: string;
  schema: Record<string, unknown>;
  hasHooks: boolean;
}

export interface SoulRoutine {
  name: string;
  config: Record<string, unknown>;
  hasHooks: boolean;
}

export interface SoulIntegration {
  name: string;
  connection: Record<string, unknown>;
}
