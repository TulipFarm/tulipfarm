import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

export type SkillReferenceErrorCode = "INVALID_NAME" | "NOT_FOUND" | "UNAVAILABLE";

export class SkillReferenceError extends Error {
  constructor(readonly code: SkillReferenceErrorCode) {
    super(
      code === "INVALID_NAME" ? "Invalid Skill reference name." : "Skill references unavailable."
    );
    this.name = "SkillReferenceError";
  }
}

export interface SkillReferenceReader {
  list(): Promise<readonly string[]>;
  read(name: string): Promise<string>;
}

export interface SkillReferenceReaderOptions {
  /** Absolute path to one Skill's references directory. */
  readonly directory: string;
  /** A loader-owned inventory may avoid walking an immutable bundled Skill tree again. */
  readonly advertisedNames?: readonly string[];
}

export const LOAD_SKILL_INPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["name"],
  properties: {
    name: { type: "string", minLength: 1, description: "Skill name as registered in the Soul." },
  },
};

export const LOAD_SKILL_REFERENCE_INPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["skill", "reference"],
  properties: {
    skill: {
      type: "string",
      minLength: 1,
      maxLength: 64,
      pattern: "^[a-z0-9][a-z0-9._-]*$",
      description: "Skill name as registered in the Soul or bundled overlay.",
    },
    reference: {
      type: "string",
      minLength: 1,
      description:
        "Reference filename within the Skill's references/ directory; use only a name advertised by load_skill.",
    },
  },
};

export const SKILL_REFERENCE_TOOL_DECLARATIONS = [
  {
    name: "load_skill",
    description:
      "Load a Skill's frontmatter, body, and normalized available reference filenames by name so the agent can apply its instructions. Request only those advertised filenames with load_skill_reference. Resolves Soul Skills before the read-only bundled overlay. Graceful not_found when the Skill is absent.",
    inputSchema: LOAD_SKILL_INPUT_SCHEMA,
  },
  {
    name: "load_skill_reference",
    description:
      "Load a reference file from a Skill's references/ directory. Request only a filename advertised by load_skill. Use this to pull in supporting material that is too large to include in the Skill body.",
    inputSchema: LOAD_SKILL_REFERENCE_INPUT_SCHEMA,
  },
] as const;

export function normalizeSkillReferenceNames(names: readonly string[]): string[] {
  return [...new Set(names.map((name) => name.replaceAll("\\", "/")))].sort((left, right) =>
    left.localeCompare(right)
  );
}

function isNotFound(error: unknown): boolean {
  return (
    error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

async function inventory(directory: string): Promise<string[]> {
  const names: string[] = [];

  async function walk(current: string): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch (error) {
      if (isNotFound(error)) return;
      throw new SkillReferenceError("UNAVAILABLE");
    }
    for (const entry of entries) {
      const path = resolve(current, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) names.push(relative(directory, path));
    }
  }

  await walk(directory);
  return normalizeSkillReferenceNames(names);
}

export function createSkillReferenceReader(
  options: SkillReferenceReaderOptions
): SkillReferenceReader {
  const directory = resolve(options.directory);
  const advertisedNames = options.advertisedNames
    ? normalizeSkillReferenceNames(options.advertisedNames)
    : undefined;

  return {
    list: async () => advertisedNames ?? inventory(directory),
    read: async (name) => {
      const path = resolve(directory, name);
      const contained = relative(directory, path);
      if (
        contained === "" ||
        contained === ".." ||
        contained.startsWith(`..${sep}`) ||
        isAbsolute(contained)
      ) {
        throw new SkillReferenceError("INVALID_NAME");
      }
      try {
        return await readFile(path, "utf8");
      } catch (error) {
        if (isNotFound(error)) throw new SkillReferenceError("NOT_FOUND");
        throw new SkillReferenceError("UNAVAILABLE");
      }
    },
  };
}
