export interface SoulMigration {
  version: number;
  description: string;
  up: (soulPath: string) => Promise<void>;
}

export const SOUL_MIGRATIONS: SoulMigration[] = [];
