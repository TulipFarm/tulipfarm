import type { SurfaceArtifact, SurfaceRenderContext } from "@tulipfarm/surface/client";
import {
  type SlackBlock,
  slackMessageRenderer,
  slackModalRenderer,
} from "@tulipfarm/surface-slack";
import { Check, Copy, MessageSquare, Terminal } from "lucide-react";
import { useMemo, useState } from "react";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { copyText } from "~/lib/clipboard";

export interface SlackPreviewProps {
  readonly artifact: SurfaceArtifact;
  readonly onInteraction?: (actionId: string, payload: Record<string, unknown>) => void;
}

function parseMrkdwn(mrkdwn: string): string {
  // Simple sanitizer and basic Slack mrkdwn parser for display
  return mrkdwn
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replace(/\*([^*]+)\*/g, "<strong>$1</strong>")
    .replace(/_([^_]+)_/g, "<em>$1</em>")
    .replace(/~([^~]+)~/g, "<del>$1</del>")
    .replace(/`([^`]+)`/g, '<code class="rounded bg-muted px-1 py-0.5 font-mono text-xs">$1</code>')
    .replace(/\n/g, "<br />");
}

export function SlackPreview({ artifact, onInteraction }: SlackPreviewProps) {
  const [viewMode, setViewMode] = useState<"visual" | "json">("visual");
  const [copied, setCopied] = useState(false);
  const [formState, setFormState] = useState<Record<string, string>>({});

  const context: SurfaceRenderContext = useMemo(
    () => ({
      destination: "sandbox",
      actionHandleFor: (action) => action.event,
    }),
    []
  );

  const { payload, error } = useMemo(() => {
    try {
      const targetSurface = artifact.component.name === "Form" ? "modal" : "message";
      const projectedArtifact: SurfaceArtifact = {
        ...artifact,
        target: { channel: "slack", surface: targetSurface },
      };
      const renderer = targetSurface === "modal" ? slackModalRenderer : slackMessageRenderer;
      const res = renderer.render(projectedArtifact, context);
      return { payload: res, error: null };
    } catch (err) {
      return { payload: null, error: err instanceof Error ? err.message : String(err) };
    }
  }, [artifact, context]);

  const jsonString = useMemo(() => {
    return payload ? JSON.stringify(payload, null, 2) : "";
  }, [payload]);

  const handleCopy = () => {
    if (!jsonString) return;
    void copyText(jsonString);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleButtonClick = (actionId: string, value: string) => {
    onInteraction?.(actionId, { value, source: "slack_block_kit" });
  };

  const handleModalSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!payload?.view) return;
    const actionId = String(payload.view.callback_id ?? "submit");
    onInteraction?.(actionId, { ...formState, source: "slack_modal" });
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between border-b border-border pb-2">
        <div className="flex items-center gap-2">
          <Badge variant="info">Slack Block Kit</Badge>
          <span className="text-xs text-muted-foreground">
            Target: slack:message · API format: Block Kit
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <Button
            variant={viewMode === "visual" ? "secondary" : "ghost"}
            size="sm"
            onClick={() => setViewMode("visual")}
            className="h-7 px-2.5 text-xs"
          >
            <MessageSquare className="size-3.5 mr-1" />
            Mockup
          </Button>
          <Button
            variant={viewMode === "json" ? "secondary" : "ghost"}
            size="sm"
            onClick={() => setViewMode("json")}
            className="h-7 px-2.5 text-xs"
          >
            <Terminal className="size-3.5 mr-1" />
            Block Kit JSON
          </Button>
        </div>
      </div>

      {error ? (
        <div className="rounded-md border border-status-danger/30 bg-status-danger/10 p-4 text-xs text-status-danger">
          <p className="font-semibold">Slack Translation Error:</p>
          <p className="mt-1 font-mono">{error}</p>
        </div>
      ) : viewMode === "json" ? (
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
                  Copy JSON
                </>
              )}
            </Button>
          </div>
          <pre className="max-h-96 overflow-auto font-mono text-xs text-foreground">
            {jsonString}
          </pre>
        </div>
      ) : (
        <div className="rounded-lg border border-border bg-card p-4 shadow-sm">
          {/* Slack Channel Header */}
          <div className="mb-3 flex items-center justify-between border-b border-border/40 pb-2 text-xs text-muted-foreground">
            <div className="flex items-center gap-1.5 font-semibold text-foreground">
              <span>#</span>
              <span>ops-notifications</span>
            </div>
            <span>Workspace: TulipFarm Enterprise</span>
          </div>

          {/* Slack Message View */}
          <div className="flex items-start gap-3">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-md bg-[#4A154B] font-bold text-white shadow-xs">
              TF
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="text-sm font-bold text-foreground">tulipfarm</span>
                <span className="rounded bg-muted px-1 py-0.5 text-[10px] font-semibold text-muted-foreground">
                  APP
                </span>
                <span className="text-xs text-muted-foreground">12:45 PM</span>
              </div>

              {/* Render Slack Blocks */}
              {payload?.blocks && payload.blocks.length > 0 ? (
                <div className="mt-2 space-y-3">
                  {payload.blocks.map((block: SlackBlock, idx: number) => {
                    if (block.type === "header") {
                      return (
                        <h4
                          key={`block-${idx}`}
                          className="text-base font-bold text-foreground tracking-tight"
                        >
                          {block.text?.text}
                        </h4>
                      );
                    }
                    if (block.type === "section") {
                      return (
                        <div key={`block-${idx}`} className="space-y-2 text-sm text-foreground">
                          {block.text?.text ? (
                            <div
                              // biome-ignore lint/security/noDangerouslySetInnerHtml: safe Slack mrkdwn render
                              dangerouslySetInnerHTML={{
                                __html: parseMrkdwn(block.text.text),
                              }}
                            />
                          ) : null}
                          {block.fields && block.fields.length > 0 ? (
                            <div className="grid grid-cols-2 gap-2 rounded border border-border/30 bg-muted/20 p-2.5">
                              {block.fields.map((field, fIdx) => (
                                <div
                                  key={`field-${fIdx}`}
                                  className="text-xs"
                                  // biome-ignore lint/security/noDangerouslySetInnerHtml: safe mrkdwn
                                  dangerouslySetInnerHTML={{
                                    __html: parseMrkdwn(field.text),
                                  }}
                                />
                              ))}
                            </div>
                          ) : null}
                          {block.accessory ? (
                            <div className="pt-1">
                              {block.accessory.type === "static_select" ||
                              block.accessory.type === "multi_static_select" ? (
                                <select
                                  aria-label="Slack accessory select"
                                  className="h-8 rounded border border-input bg-background px-2 text-xs"
                                  onChange={(e) =>
                                    handleButtonClick(
                                      String(block.accessory?.action_id ?? "select"),
                                      e.target.value
                                    )
                                  }
                                >
                                  <option value="">Select option...</option>
                                  {(
                                    (block.accessory.options as Array<{
                                      text: { text: string };
                                      value: string;
                                    }>) ?? []
                                  ).map((opt) => (
                                    <option key={opt.value} value={opt.value}>
                                      {opt.text.text}
                                    </option>
                                  ))}
                                </select>
                              ) : null}
                            </div>
                          ) : null}
                        </div>
                      );
                    }
                    if (block.type === "context") {
                      return (
                        <div
                          key={`block-${idx}`}
                          className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground"
                        >
                          {block.elements?.map((el, elIdx) => (
                            <span
                              key={`el-${elIdx}`}
                              // biome-ignore lint/security/noDangerouslySetInnerHtml: safe mrkdwn
                              dangerouslySetInnerHTML={{
                                __html: parseMrkdwn(String((el as { text?: string }).text ?? "")),
                              }}
                            />
                          ))}
                        </div>
                      );
                    }
                    if (block.type === "divider") {
                      return <hr key={`block-${idx}`} className="border-border/50 my-2" />;
                    }
                    if (block.type === "actions") {
                      return (
                        <div key={`block-${idx}`} className="flex flex-wrap gap-2 pt-1">
                          {block.elements?.map((el, bIdx) => {
                            const btn = el as {
                              type: string;
                              text: { text: string };
                              action_id: string;
                              value?: string;
                              style?: string;
                            };
                            const isPrimary = bIdx === 0;
                            return (
                              <button
                                key={`btn-${bIdx}`}
                                type="button"
                                onClick={() =>
                                  handleButtonClick(btn.action_id, btn.value ?? btn.text.text)
                                }
                                className={`rounded px-3 py-1.5 text-xs font-semibold transition-colors focus-visible:ring-2 ${
                                  isPrimary
                                    ? "bg-[#007a5a] text-white hover:bg-[#148567]"
                                    : "border border-input bg-background hover:bg-accent text-foreground"
                                }`}
                              >
                                {btn.text.text}
                              </button>
                            );
                          })}
                        </div>
                      );
                    }
                    if (block.type === "image") {
                      return (
                        <div key={`block-${idx}`} className="my-2">
                          <img
                            src={block.image_url}
                            alt={block.alt_text ?? "Slack image"}
                            className="max-h-48 rounded border border-border object-contain"
                          />
                          {block.title ? (
                            <p className="mt-1 text-xs text-muted-foreground">{block.title.text}</p>
                          ) : null}
                        </div>
                      );
                    }
                    return null;
                  })}
                </div>
              ) : null}

              {/* Render Slack Modal View if present */}
              {payload?.view ? (
                <div className="mt-4 rounded-md border-2 border-[#4A154B]/30 bg-muted/10 p-4">
                  <div className="mb-3 flex items-center justify-between border-b border-border pb-2">
                    <h5 className="font-bold text-sm text-foreground">
                      {String((payload.view.title as { text?: string })?.text ?? "Modal View")}
                    </h5>
                    <Badge variant="neutral">Slack Modal View</Badge>
                  </div>
                  <form onSubmit={handleModalSubmit} className="space-y-3">
                    {(
                      (payload.view.blocks as Array<{
                        type: string;
                        block_id: string;
                        label: { text: string };
                        element: {
                          type: string;
                          action_id: string;
                          options?: Array<{ text: { text: string }; value: string }>;
                        };
                        optional?: boolean;
                      }>) ?? []
                    ).map((mBlock) => {
                      const inputId = `slack-input-${mBlock.block_id}`;
                      return (
                        <div key={mBlock.block_id} className="space-y-1">
                          <label
                            htmlFor={inputId}
                            className="block text-xs font-medium text-foreground"
                          >
                            {mBlock.label?.text}{" "}
                            {mBlock.optional ? (
                              <span className="text-muted-foreground">(optional)</span>
                            ) : null}
                          </label>
                          {mBlock.element?.type === "plain_text_input" ? (
                            <input
                              id={inputId}
                              type="text"
                              placeholder="Enter text..."
                              className="h-8 w-full rounded border border-input bg-background px-2.5 text-xs"
                              value={formState[mBlock.block_id] ?? ""}
                              onChange={(e) =>
                                setFormState((prev) => ({
                                  ...prev,
                                  [mBlock.block_id]: e.target.value,
                                }))
                              }
                            />
                          ) : mBlock.element?.type === "email_text_input" ? (
                            <input
                              id={inputId}
                              type="email"
                              placeholder="user@example.com"
                              className="h-8 w-full rounded border border-input bg-background px-2.5 text-xs"
                              value={formState[mBlock.block_id] ?? ""}
                              onChange={(e) =>
                                setFormState((prev) => ({
                                  ...prev,
                                  [mBlock.block_id]: e.target.value,
                                }))
                              }
                            />
                          ) : mBlock.element?.type === "static_select" ? (
                            <select
                              id={inputId}
                              className="h-8 w-full rounded border border-input bg-background px-2 text-xs"
                              value={formState[mBlock.block_id] ?? ""}
                              onChange={(e) =>
                                setFormState((prev) => ({
                                  ...prev,
                                  [mBlock.block_id]: e.target.value,
                                }))
                              }
                            >
                              <option value="">Select an option</option>
                              {(mBlock.element.options ?? []).map((opt) => (
                                <option key={opt.value} value={opt.value}>
                                  {opt.text.text}
                                </option>
                              ))}
                            </select>
                          ) : (
                            <input
                              id={inputId}
                              type="text"
                              className="h-8 w-full rounded border border-input bg-background px-2.5 text-xs"
                              value={formState[mBlock.block_id] ?? ""}
                              onChange={(e) =>
                                setFormState((prev) => ({
                                  ...prev,
                                  [mBlock.block_id]: e.target.value,
                                }))
                              }
                            />
                          )}
                        </div>
                      );
                    })}
                    <div className="flex justify-end gap-2 pt-2">
                      <button
                        type="submit"
                        className="rounded bg-[#007a5a] px-4 py-1.5 text-xs font-semibold text-white hover:bg-[#148567]"
                      >
                        {String((payload.view.submit as { text?: string })?.text ?? "Submit")}
                      </button>
                    </div>
                  </form>
                </div>
              ) : null}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
