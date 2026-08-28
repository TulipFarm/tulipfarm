import { MODEL_PROFILE_MIGRATION } from "./001-model-profiles";
import { REMOVE_MODEL_FILES_MIGRATION } from "./002-remove-model-files";
import { EMBED_TRIGGERS_MIGRATION } from "./003-embed-triggers";

export interface SoulMigration {
  version: number;
  description: string;
  up: (soulPath: string) => Promise<void>;
}

export const SOUL_MIGRATIONS: SoulMigration[] = [
  MODEL_PROFILE_MIGRATION,
  REMOVE_MODEL_FILES_MIGRATION,
  EMBED_TRIGGERS_MIGRATION,
];
