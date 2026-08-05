import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { EvalReportSink, EvalRunReport } from "./types";

/** Collects reports in memory. For tests and for chaining multiple sinks in a run. */
export function inMemorySink(): EvalReportSink & { readonly reports: EvalRunReport[] } {
  const reports: EvalRunReport[] = [];
  return {
    reports,
    async write(report) {
      reports.push(report);
    },
  };
}

function slug(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, "-");
}

/** Human-readable summary of a run: one line per case plus the headline pass/fail count. */
export function renderMarkdown(report: EvalRunReport): string {
  const lines = [
    `# Eval report: ${report.suite} (${report.suiteVersion})`,
    "",
    `- Agent: ${report.agentId} @ ${report.agentVersion}`,
    `- Started: ${report.startedAt}`,
    `- Finished: ${report.finishedAt}`,
    `- Result: ${report.passed} passed, ${report.failed} failed`,
    `- Digest: ${report.digest}`,
    "",
    "## Cases",
    "",
  ];
  for (const result of report.results) {
    const status = result.passed ? "PASS" : "FAIL";
    lines.push(
      `- ${status} ${result.caseId} (${result.severity}) — ${result.passes}/${result.runs} runs, ` +
        `threshold ${(result.minPassRate * 100).toFixed(0)}%`
    );
  }
  lines.push("");
  return lines.join("\n");
}

export interface FileSinkOptions {
  readonly dir: string;
  /** When true (default) also write `<suite>-latest.json` for easy diffing/baselines. */
  readonly writeLatest?: boolean;
}

/** Writes each report as timestamped JSON + Markdown under `dir`, plus a `<suite>-latest.json`. */
export function fileSink(options: FileSinkOptions): EvalReportSink {
  return {
    async write(report) {
      await mkdir(options.dir, { recursive: true });
      const stamp = report.finishedAt.replace(/[:.]/g, "-");
      const base = `${slug(report.suite)}-${stamp}`;
      await writeFile(path.join(options.dir, `${base}.json`), JSON.stringify(report, null, 2));
      await writeFile(path.join(options.dir, `${base}.md`), renderMarkdown(report));
      if (options.writeLatest !== false) {
        await writeFile(
          path.join(options.dir, `${slug(report.suite)}-latest.json`),
          JSON.stringify(report, null, 2)
        );
      }
    },
  };
}
