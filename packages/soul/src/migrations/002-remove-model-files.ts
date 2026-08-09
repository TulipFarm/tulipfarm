import { readdir, readFile, rm } from "node:fs/promises";
import { extname, join } from "node:path";
import { parse as parseYaml } from "yaml";
import { isGeneratedModelProfile } from "../model-profile-documents";
import type { SoulMigration } from "./index";

const MODELS_DIR = "models";

/** Remove the retired v1 projection, but never silently erase unknown authored governance. */
export async function removeGeneratedModelFiles(soulPath: string): Promise<void> {
  const directory = join(soulPath, MODELS_DIR);
  let entries: import("node:fs").Dirent<string>[];
  try {
    entries = await readdir(directory, { withFileTypes: true, encoding: "utf8" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }

  for (const entry of entries) {
    const name = String(entry.name);
    const extension = extname(name);
    if (!entry.isFile() || (extension !== ".yaml" && extension !== ".yml")) {
      throw new Error(`retired models directory contains unrecognized entry: ${name}`);
    }
    const slug = name.slice(0, -extension.length);
    const document = parseYaml(await readFile(join(directory, name), "utf8"));
    if (!isGeneratedModelProfile(document, slug)) {
      throw new Error(`retired models directory contains non-generated profile: ${name}`);
    }
  }

  await rm(directory, { recursive: true });
}

export const REMOVE_MODEL_FILES_MIGRATION: SoulMigration = {
  version: 2,
  description: "remove generated ModelProfile files; soul.yaml is authoritative",
  up: removeGeneratedModelFiles,
};
