import { MODEL_PROFILE_MIGRATION } from "./001-model-profiles";

export interface SoulMigration {
  version: number;
  description: string;
  up: (soulPath: string) => Promise<void>;
}

export const SOUL_MIGRATIONS: SoulMigration[] = [MODEL_PROFILE_MIGRATION];
