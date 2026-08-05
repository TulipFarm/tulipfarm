import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";
import type { DatasetSource, EvalCase, EvalDataset } from "./types";

/**
 * File-backed dataset source. A suite lives at `<dir>/<suite>.yaml` with `suite`, `suiteVersion`,
 * and `cases`. This is the Phase 1 storage; the `DatasetSource` port lets Phase 2 swap in a
 * database-backed source without touching the runner or scorers.
 */

export class DatasetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DatasetError";
  }
}

interface RawDataset {
  readonly suite?: unknown;
  readonly suiteVersion?: unknown;
  readonly cases?: unknown;
}

function requireString(value: unknown, field: string, suite: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new DatasetError(`suite "${suite}" is missing required string field "${field}"`);
  }
  return value;
}

function coerceCase(raw: unknown, suite: string, index: number): EvalCase {
  if (typeof raw !== "object" || raw === null) {
    throw new DatasetError(`suite "${suite}" case #${index} is not an object`);
  }
  const record = raw as Record<string, unknown>;
  const severity = record.severity === "advisory" ? "advisory" : "blocking";
  if (typeof record.input !== "object" || record.input === null) {
    throw new DatasetError(`suite "${suite}" case #${index} is missing an "input" object`);
  }
  return {
    caseId: requireString(record.caseId, `cases[${index}].caseId`, suite),
    version: requireString(record.version, `cases[${index}].version`, suite),
    severity,
    input: record.input as EvalCase["input"],
    ...(record.expected === undefined ? {} : { expected: record.expected }),
    ...(typeof record.rubric === "string" ? { rubric: record.rubric } : {}),
    ...(record.target === "model" || record.target === "agent-loop"
      ? { target: record.target }
      : {}),
    ...(Array.isArray(record.tags)
      ? { tags: record.tags.filter((tag): tag is string => typeof tag === "string") }
      : {}),
    ...(typeof record.metadata === "object" && record.metadata !== null
      ? { metadata: record.metadata as Record<string, unknown> }
      : {}),
    ...(typeof record.runs === "number" ? { runs: record.runs } : {}),
    ...(typeof record.minPassRate === "number" ? { minPassRate: record.minPassRate } : {}),
  };
}

export function coerceDataset(raw: unknown, suite: string): EvalDataset {
  const data = (raw ?? {}) as RawDataset;
  const cases = Array.isArray(data.cases) ? data.cases : [];
  return {
    suite: requireString(data.suite, "suite", suite),
    suiteVersion: requireString(data.suiteVersion, "suiteVersion", suite),
    cases: cases.map((raw, index) => coerceCase(raw, suite, index)),
  };
}

export interface FileDatasetSourceOptions {
  readonly dir: string;
}

export function fileDatasetSource(options: FileDatasetSourceOptions): DatasetSource {
  return {
    async load(suite: string): Promise<EvalDataset> {
      const file = path.join(options.dir, `${suite}.yaml`);
      let contents: string;
      try {
        contents = await readFile(file, "utf8");
      } catch {
        throw new DatasetError(`suite "${suite}" not found at ${file}`);
      }
      return coerceDataset(parse(contents), suite);
    },
  };
}
