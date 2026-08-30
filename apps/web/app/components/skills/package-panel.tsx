import { useCallback, useId, useState } from "react";
import { MarkdownView } from "~/components/markdown-view";
import { Panel } from "~/components/ui/panel";
import {
  formatBytes,
  groupPackageFiles,
  isReadableSkillFile,
  SKILL_FILE_KIND_HINT,
  SKILL_FILE_KIND_LABEL,
} from "~/lib/skill-facts";
import { getSkillFile, type SkillFileContent, type SkillPackageFile } from "~/lib/skills";

type FileState =
  | { status: "loading" }
  | { status: "ready"; file: SkillFileContent }
  | { status: "error"; message: string };

function isMarkdown(path: string): boolean {
  return path.endsWith(".md") || path.endsWith(".mdx");
}

function FileBody({ state }: { state: FileState }) {
  if (state.status === "loading")
    return <p className="px-4 py-3 text-sm text-muted-foreground">Loading…</p>;
  if (state.status === "error")
    return (
      <p className="px-4 py-3 text-sm text-status-danger">
        This file could not be read. {state.message}
      </p>
    );

  const { file } = state;
  if (file.binary)
    return (
      <p className="px-4 py-3 text-sm text-muted-foreground">
        This file is not text, so there is nothing to show here.
      </p>
    );

  return (
    <div className="px-4 py-3">
      {isMarkdown(file.path) ? (
        <MarkdownView>{file.content}</MarkdownView>
      ) : (
        <pre className="max-h-[32rem] overflow-auto rounded-sm bg-muted/50 p-3 font-mono text-xs leading-relaxed text-foreground">
          <code>{file.content}</code>
        </pre>
      )}
      {file.truncated ? (
        <p className="mt-2 text-xs text-muted-foreground">
          Only the first part of this file is shown because it is very long.
        </p>
      ) : null}
    </div>
  );
}

/**
 * Everything the Skill package ships, grouped by what each file is for and readable in place.
 *
 * A path and a byte count is not an answer to "what is in this skill" — the reference a Skill tells
 * an agent to open is the half of the Skill that is not in `SKILL.md`, and a script is the part an
 * operator most needs to read before trusting it. So each file opens, and it opens *here* rather
 * than on a route of its own: the question is always asked while comparing it to the rest of the
 * package, and a navigation would drop that context to show one file.
 *
 * Bodies are fetched on demand and cached per path. A package can carry a megabyte of references
 * that nobody opens, so loading them with the page would make the common visit pay for the rare one.
 */
export function SkillPackagePanel({
  skillName,
  files,
}: {
  skillName: string;
  files: readonly SkillPackageFile[];
}) {
  const baseId = useId();
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [contents, setContents] = useState<Record<string, FileState>>({});

  const toggle = useCallback(
    (path: string) => {
      setOpen((previous) => {
        const next = new Set(previous);
        if (next.has(path)) {
          next.delete(path);
          return next;
        }
        next.add(path);
        return next;
      });
      setContents((previous) => {
        // Already fetched or in flight — a second open must not re-request or clear what is shown.
        if (previous[path]) return previous;
        void getSkillFile(skillName, path)
          .then((file) =>
            setContents((current) => ({ ...current, [path]: { status: "ready", file } }))
          )
          .catch((error: unknown) =>
            setContents((current) => ({
              ...current,
              [path]: {
                status: "error",
                message: error instanceof Error ? error.message : "The request failed.",
              },
            }))
          );
        return { ...previous, [path]: { status: "loading" } };
      });
    },
    [skillName]
  );

  const groups = groupPackageFiles(files);
  if (groups.length === 0) return null;

  return (
    <Panel
      flush
      title="What is in the package"
      description={`${files.length} ${files.length === 1 ? "file" : "files"}. Open any of them to read exactly what this skill ships.`}
    >
      <div className="flex flex-col">
        {groups.map(([kind, group]) => (
          <section key={kind} className="border-b border-border last:border-b-0">
            <div className="bg-muted/30 px-4 py-2">
              <h3 className="text-xs font-medium text-foreground">
                {SKILL_FILE_KIND_LABEL[kind]}
                <span className="ml-1.5 font-mono tabular-nums text-muted-foreground">
                  {group.length}
                </span>
              </h3>
              <p className="text-xs text-muted-foreground">{SKILL_FILE_KIND_HINT[kind]}</p>
            </div>
            <ul className="flex flex-col">
              {group.map((file) => {
                const readable = isReadableSkillFile(file.path);
                const expanded = open.has(file.path);
                const panelId = `${baseId}-${file.path}`;
                return (
                  <li key={file.path} className="border-t border-border">
                    {readable ? (
                      <>
                        <button
                          type="button"
                          aria-expanded={expanded}
                          aria-controls={panelId}
                          onClick={() => toggle(file.path)}
                          className="flex w-full items-center gap-2 px-4 py-2 text-left outline-none transition-colors hover:bg-muted/40 focus-visible:ring-[3px] focus-visible:ring-inset focus-visible:ring-ring/50"
                        >
                          <span
                            aria-hidden
                            className={`shrink-0 font-mono text-[11px] text-muted-foreground transition-transform ${expanded ? "rotate-90" : ""}`}
                          >
                            ▸
                          </span>
                          <span className="min-w-0 flex-1 truncate font-mono text-xs text-foreground">
                            {file.path}
                          </span>
                          <span className="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">
                            {formatBytes(file.size)}
                          </span>
                        </button>
                        {expanded ? (
                          <div id={panelId} className="border-t border-border bg-muted/20">
                            <FileBody state={contents[file.path] ?? { status: "loading" }} />
                          </div>
                        ) : null}
                      </>
                    ) : (
                      <div className="flex items-center gap-2 px-4 py-2">
                        <span
                          aria-hidden
                          className="shrink-0 font-mono text-[11px] text-transparent"
                        >
                          ▸
                        </span>
                        <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
                          {file.path}
                        </span>
                        <span className="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">
                          {formatBytes(file.size)}
                        </span>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </div>
    </Panel>
  );
}
