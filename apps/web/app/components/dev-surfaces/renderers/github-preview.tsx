import type { SurfaceArtifact, SurfaceRenderContext } from "@tulipfarm/surface";
import {
  createGitHubRenderer,
  type GitHubCheckRunPayload,
  type GitHubCommentPayload,
  githubCommentRenderer,
} from "@tulipfarm/surface-github";
import {
  Check,
  CheckCircle2,
  Copy,
  GitPullRequest,
  ShieldAlert,
  Terminal,
  XCircle,
} from "lucide-react";
import { useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { copyText } from "~/lib/clipboard";

export interface GitHubPreviewProps {
  readonly artifact: SurfaceArtifact;
  readonly onInteraction?: (actionId: string, payload: Record<string, unknown>) => void;
}

const checkRunRenderer = createGitHubRenderer("check-run");

export function GitHubPreview({ artifact, onInteraction }: GitHubPreviewProps) {
  const [surfaceType, setSurfaceType] = useState<"comment" | "check-run">("comment");
  const [viewMode, setViewMode] = useState<"visual" | "raw">("visual");
  const [copied, setCopied] = useState(false);

  const context: SurfaceRenderContext = useMemo(
    () => ({
      destination: "sandbox",
      actionHandleFor: (action) => action.event,
    }),
    []
  );

  const { commentPayload, commentError } = useMemo(() => {
    try {
      const projectedCommentArtifact: SurfaceArtifact = {
        ...artifact,
        target: { channel: "github", surface: "comment" },
      };
      const res = githubCommentRenderer.render(projectedCommentArtifact, context);
      return { commentPayload: res as GitHubCommentPayload, commentError: null };
    } catch (err) {
      return {
        commentPayload: null,
        commentError: err instanceof Error ? err.message : String(err),
      };
    }
  }, [artifact, context]);

  const { checkRunPayload, checkRunError } = useMemo(() => {
    try {
      const projectedCheckRunArtifact: SurfaceArtifact = {
        ...artifact,
        target: { channel: "github", surface: "check-run" },
      };
      const res = checkRunRenderer.render(projectedCheckRunArtifact, context);
      return { checkRunPayload: res as GitHubCheckRunPayload, checkRunError: null };
    } catch (err) {
      return {
        checkRunPayload: null,
        checkRunError: err instanceof Error ? err.message : String(err),
      };
    }
  }, [artifact, context]);

  const activePayload = surfaceType === "comment" ? commentPayload : checkRunPayload;
  const activeError = surfaceType === "comment" ? commentError : checkRunError;

  const rawString = useMemo(() => {
    if (!activePayload) return "";
    if (surfaceType === "comment") {
      return (activePayload as GitHubCommentPayload).body;
    }
    return JSON.stringify(activePayload, null, 2);
  }, [activePayload, surfaceType]);

  const handleCopy = () => {
    if (!rawString) return;
    void copyText(rawString);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleActionClick = (identifier: string, label: string) => {
    onInteraction?.(identifier, { label, source: "github_check_run" });
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border pb-2">
        <div className="flex items-center gap-2">
          <Badge variant="info">GitHub Renderer</Badge>
          <div className="flex rounded-md border border-border p-0.5 text-xs bg-muted/40">
            <button
              type="button"
              onClick={() => setSurfaceType("comment")}
              className={`rounded px-2.5 py-0.5 font-medium transition-colors ${
                surfaceType === "comment"
                  ? "bg-background text-foreground shadow-xs"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              Issue / PR Comment
            </button>
            <button
              type="button"
              onClick={() => setSurfaceType("check-run")}
              className={`rounded px-2.5 py-0.5 font-medium transition-colors ${
                surfaceType === "check-run"
                  ? "bg-background text-foreground shadow-xs"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              Check Run Card
            </button>
          </div>
        </div>

        <div className="flex items-center gap-1.5">
          <Button
            variant={viewMode === "visual" ? "secondary" : "ghost"}
            size="sm"
            onClick={() => setViewMode("visual")}
            className="h-7 px-2.5 text-xs"
          >
            <GitPullRequest className="size-3.5 mr-1" />
            Mockup
          </Button>
          <Button
            variant={viewMode === "raw" ? "secondary" : "ghost"}
            size="sm"
            onClick={() => setViewMode("raw")}
            className="h-7 px-2.5 text-xs"
          >
            <Terminal className="size-3.5 mr-1" />
            {surfaceType === "comment" ? "Markdown" : "Payload JSON"}
          </Button>
        </div>
      </div>

      {activeError ? (
        <div className="rounded-md border border-status-danger/30 bg-status-danger/10 p-4 text-xs text-status-danger">
          <p className="font-semibold">GitHub Translation Error:</p>
          <p className="mt-1 font-mono">{activeError}</p>
        </div>
      ) : viewMode === "raw" ? (
        <div className="relative rounded-md border border-border bg-muted/40 p-3">
          <div className="absolute top-2 right-2">
            <Button variant="outline" size="sm" onClick={handleCopy} className="h-7 text-xs">
              {copied ? (
                <>
                  <Check className="size-3 mr-1 text-status-success" />
                  Copied
                </>
              ) : (
                <>
                  <Copy className="size-3 mr-1" />
                  Copy
                </>
              )}
            </Button>
          </div>
          <pre className="max-h-96 overflow-auto font-mono text-xs text-foreground whitespace-pre-wrap">
            {rawString}
          </pre>
        </div>
      ) : surfaceType === "comment" && commentPayload ? (
        /* GitHub Comment Card */
        <div className="rounded-md border border-border bg-card shadow-xs">
          <div className="flex items-center justify-between border-b border-border bg-muted/30 px-3.5 py-2 text-xs">
            <div className="flex items-center gap-2">
              <div className="flex size-5 items-center justify-center rounded-full bg-primary font-bold text-[10px] text-primary-foreground">
                T
              </div>
              <span className="font-semibold text-foreground">tulipfarm</span>
              <span className="rounded border border-border bg-muted px-1 py-0.2 text-[10px] font-medium text-muted-foreground">
                bot
              </span>
              <span className="text-muted-foreground">commented just now</span>
            </div>
            <span className="text-[11px] text-muted-foreground">GitHub Markdown</span>
          </div>
          <div className="p-4 prose dark:prose-invert max-w-none text-sm leading-relaxed [&_table]:w-full [&_table]:border-collapse [&_th]:border [&_th]:border-border [&_th]:bg-muted/30 [&_th]:px-3 [&_th]:py-1.5 [&_th]:text-left [&_th]:text-xs [&_th]:font-semibold [&_td]:border [&_td]:border-border [&_td]:px-3 [&_td]:py-1.5 [&_td]:text-xs [&_blockquote]:border-l-4 [&_blockquote]:border-primary/50 [&_blockquote]:pl-3 [&_blockquote]:italic [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-xs">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{commentPayload.body}</ReactMarkdown>
          </div>
        </div>
      ) : surfaceType === "check-run" && checkRunPayload ? (
        /* GitHub Check Run Card */
        <div className="rounded-md border border-border bg-card shadow-xs">
          <div className="flex items-center justify-between border-b border-border bg-muted/30 px-3.5 py-2.5 text-xs">
            <div className="flex items-center gap-2.5">
              {checkRunPayload.conclusion === "success" ? (
                <CheckCircle2 className="size-4 text-status-success" />
              ) : checkRunPayload.conclusion === "failure" ? (
                <XCircle className="size-4 text-status-danger" />
              ) : (
                <ShieldAlert className="size-4 text-status-warning" />
              )}
              <span className="font-semibold text-sm text-foreground">
                {checkRunPayload.output.title}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <Badge
                variant={
                  checkRunPayload.conclusion === "success"
                    ? "success"
                    : checkRunPayload.conclusion === "failure"
                      ? "danger"
                      : "warning"
                }
              >
                {checkRunPayload.conclusion.toUpperCase()}
              </Badge>
              <span className="text-muted-foreground">Check Run</span>
            </div>
          </div>
          <div className="p-4 space-y-3">
            <div className="prose dark:prose-invert max-w-none text-sm [&_table]:w-full [&_table]:border-collapse [&_th]:border [&_th]:border-border [&_th]:bg-muted/30 [&_th]:px-3 [&_th]:py-1.5 [&_th]:text-left [&_th]:text-xs [&_td]:border [&_td]:border-border [&_td]:px-3 [&_td]:py-1.5 [&_td]:text-xs">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {checkRunPayload.output.summary}
              </ReactMarkdown>
            </div>
            {checkRunPayload.actions && checkRunPayload.actions.length > 0 ? (
              <div className="flex flex-wrap gap-2 border-t border-border pt-3">
                {checkRunPayload.actions.map((act) => (
                  <Button
                    key={act.identifier}
                    variant="outline"
                    size="sm"
                    onClick={() => handleActionClick(act.identifier, act.label)}
                    className="text-xs h-7"
                  >
                    {act.label}
                  </Button>
                ))}
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
