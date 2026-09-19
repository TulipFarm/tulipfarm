export const PACK_MAX_BYTES = 128 * 1024;
export const PACK_READ_MAX_RESULT_CHARS = 38_000;
export const PACK_MAX_ARTIFACTS = 64;
export const PACK_CATALOG_MAX_ENTRIES = 100;
export const PACK_CATEGORIES = [
  "Sales",
  "IT Ops",
  "Marketing",
  "Document Ops",
  "Support",
  "Engineering",
] as const;

export type {
  PackCatalogEntry,
  PackDefinition,
  PackPreview,
  PackReadInput,
  PackSource,
} from "./pack";
