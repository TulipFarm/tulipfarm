import type { SurfaceRenderIssue } from "@tulipfarm/surface/client";
import { useState } from "react";
import {
  AlertCircle,
  AlertTriangle,
  Check,
  CheckCircle2,
  Code2,
  Copy,
  RotateCcw,
  Sparkles,
} from "~/components/icons";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Textarea } from "~/components/ui/textarea";
import { copyText } from "~/lib/clipboard";

export interface JsonEditorProps {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly onResetPreset: () => void;
  readonly validationIssues: readonly SurfaceRenderIssue[];
  readonly syntaxError: string | null;
  readonly isValid: boolean;
}

export function JsonEditor({
  value,
  onChange,
  onResetPreset,
  validationIssues,
  syntaxError,
  isValid,
}: JsonEditorProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    void copyText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleFormat = () => {
    try {
      const parsed = JSON.parse(value);
      onChange(JSON.stringify(parsed, null, 2));
    } catch {
      // Ignore format if syntax error
    }
  };

  const handleInjectInvalidComponent = () => {
    try {
      const parsed = JSON.parse(value);
      parsed.component = { name: "unknown_widget_xyz", version: "1.0" };
      onChange(JSON.stringify(parsed, null, 2));
    } catch {
      onChange(
        JSON.stringify(
          {
            id: "invalid-specimen",
            component: { name: "unknown_widget_xyz", version: "1.0" },
            props: { invalid: true },
            target: { channel: "web", surface: "chat" },
            audience: ["developer"],
            classification: "internal",
          },
          null,
          2
        )
      );
    }
  };

  const handleClearPayload = () => {
    onChange("{}");
  };

  return (
    <div className="flex flex-col gap-3">
      {/* Editor Header */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border pb-2">
        <div className="flex items-center gap-2">
          <Code2 className="size-4 text-primary" />
          <span className="font-semibold text-sm text-foreground">Raw JSON Payload</span>
          {isValid ? (
            <Badge variant="success" className="gap-1">
              <CheckCircle2 className="size-3" />
              Valid TSP
            </Badge>
          ) : syntaxError ? (
            <Badge variant="danger" className="gap-1">
              <AlertCircle className="size-3" />
              Syntax Error
            </Badge>
          ) : (
            <Badge variant="warning" className="gap-1">
              <AlertTriangle className="size-3" />
              {validationIssues.length} Schema {validationIssues.length === 1 ? "Issue" : "Issues"}
            </Badge>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={handleFormat}
            className="h-7 text-xs"
            title="Format JSON"
          >
            <Sparkles className="size-3 mr-1" />
            Format
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={handleCopy}
            className="h-7 text-xs"
            title="Copy JSON"
          >
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
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onResetPreset}
            className="h-7 text-xs"
            title="Reset to current preset"
          >
            <RotateCcw className="size-3 mr-1" />
            Reset
          </Button>
        </div>
      </div>

      {/* Quick Testing Actions Bar */}
      <div className="flex flex-wrap items-center gap-1.5 rounded-md border border-border bg-muted/30 p-2 text-xs">
        <span className="font-medium text-muted-foreground mr-1">Resilience Test:</span>
        <button
          type="button"
          onClick={handleInjectInvalidComponent}
          className="rounded border border-border bg-background px-2 py-1 hover:bg-accent text-foreground transition-colors"
        >
          Inject Invalid Component
        </button>
        <button
          type="button"
          onClick={handleClearPayload}
          className="rounded border border-border bg-background px-2 py-1 hover:bg-accent text-foreground transition-colors"
        >
          Clear Payload ({})
        </button>
      </div>

      {/* Validation Issue Banner */}
      {syntaxError ? (
        <div
          role="alert"
          className="rounded-md border border-status-danger/30 bg-status-danger/10 p-3 text-xs text-status-danger"
        >
          <p className="font-semibold flex items-center gap-1.5">
            <AlertCircle className="size-3.5" />
            Malformed JSON Syntax
          </p>
          <p className="mt-1 font-mono text-[11px] break-all">{syntaxError}</p>
        </div>
      ) : validationIssues.length > 0 ? (
        <div
          role="alert"
          className="rounded-md border border-status-warning/30 bg-status-warning/10 p-3 text-xs text-status-warning"
        >
          <p className="font-semibold flex items-center gap-1.5">
            <AlertTriangle className="size-3.5" />
            Schema Validation Issues ({validationIssues.length})
          </p>
          <ul className="mt-1.5 list-disc space-y-1 pl-4 font-mono text-[11px]">
            {validationIssues.map((issue, idx) => (
              <li key={`issue-${idx}`}>
                <span className="font-semibold">[{issue.code}]</span> {issue.path}: {issue.message}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* JSON Payload Textarea */}
      <Textarea
        aria-label="Raw JSON payload editor"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="min-h-[380px] font-mono text-xs leading-relaxed bg-muted/20 focus-visible:ring-primary resize-y"
        spellCheck={false}
      />
    </div>
  );
}
