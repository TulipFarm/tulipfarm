import type { SurfaceArtifact, SurfaceRenderContext } from "@tulipfarm/surface";
import { telegramRenderer } from "@tulipfarm/surface-telegram";
import { Check, Copy, MessageCircle, Terminal } from "lucide-react";
import { useMemo, useState } from "react";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { copyText } from "~/lib/clipboard";

export interface TelegramPreviewProps {
  readonly artifact: SurfaceArtifact;
  readonly onInteraction?: (actionId: string, payload: Record<string, unknown>) => void;
}

export function TelegramPreview({ artifact, onInteraction }: TelegramPreviewProps) {
  const [viewMode, setViewMode] = useState<"visual" | "json">("visual");
  const [copied, setCopied] = useState(false);

  const context: SurfaceRenderContext = useMemo(
    () => ({
      destination: "sandbox",
      actionHandleFor: (action) => action.event,
    }),
    []
  );

  const { payload, error } = useMemo(() => {
    try {
      const projectedArtifact: SurfaceArtifact = {
        ...artifact,
        target: { channel: "telegram", surface: "message" },
      };
      const res = telegramRenderer.render(projectedArtifact, context);
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

  const handleButtonClick = (callbackData: string, text: string) => {
    onInteraction?.(callbackData, { text, source: "telegram_inline_keyboard" });
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between border-b border-border pb-2">
        <div className="flex items-center gap-2">
          <Badge variant="info">Telegram Bot API</Badge>
          <span className="text-xs text-muted-foreground">
            Target: telegram:message · parse_mode: HTML
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <Button
            variant={viewMode === "visual" ? "secondary" : "ghost"}
            size="sm"
            onClick={() => setViewMode("visual")}
            className="h-7 px-2.5 text-xs"
          >
            <MessageCircle className="size-3.5 mr-1" />
            Mockup
          </Button>
          <Button
            variant={viewMode === "json" ? "secondary" : "ghost"}
            size="sm"
            onClick={() => setViewMode("json")}
            className="h-7 px-2.5 text-xs"
          >
            <Terminal className="size-3.5 mr-1" />
            Payload JSON
          </Button>
        </div>
      </div>

      {error ? (
        <div className="rounded-md border border-status-danger/30 bg-status-danger/10 p-4 text-xs text-status-danger">
          <p className="font-semibold">Telegram Translation Error:</p>
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
        <div className="rounded-lg border border-border bg-[#0e1621] p-4 text-white dark:bg-[#0e1621] shadow-sm">
          {/* Telegram Chat Header */}
          <div className="mb-4 flex items-center justify-between border-b border-white/10 pb-2 text-xs text-gray-400">
            <div className="flex items-center gap-2">
              <div className="flex size-7 items-center justify-center rounded-full bg-[#2481cc] font-bold text-white text-xs">
                TF
              </div>
              <div>
                <span className="font-semibold text-white">TulipFarm Bot</span>
                <span className="ml-1.5 rounded bg-[#2481cc]/20 px-1 py-0.2 text-[10px] text-[#2481cc]">
                  bot
                </span>
              </div>
            </div>
            <span className="text-[11px]">Chat ID: -100411099</span>
          </div>

          {/* Telegram Message Bubble */}
          <div className="max-w-xl space-y-2">
            <div className="rounded-2xl rounded-tl-xs bg-[#182533] p-3.5 shadow-md">
              <div
                className="prose prose-invert max-w-none text-sm text-gray-100 leading-relaxed font-sans [&_b]:font-semibold [&_b]:text-white [&_i]:italic [&_code]:rounded [&_code]:bg-[#0e1621] [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-xs [&_code]:text-[#6ab2f2] [&_pre]:rounded [&_pre]:bg-[#0e1621] [&_pre]:p-2 [&_pre]:text-xs"
                // biome-ignore lint/security/noDangerouslySetInnerHtml: Telegram HTML parser is standard
                dangerouslySetInnerHTML={{
                  __html: payload?.text ?? "",
                }}
              />
              <div className="mt-1 flex justify-end text-[10px] text-gray-400">
                12:46 PM <span className="ml-1 text-[#2481cc]">✓✓</span>
              </div>
            </div>

            {/* Inline Keyboard */}
            {payload?.reply_markup?.inline_keyboard &&
            payload.reply_markup.inline_keyboard.length > 0 ? (
              <div className="space-y-1.5 pt-1">
                {payload.reply_markup.inline_keyboard.map((row, rIdx) => (
                  <div key={`tg-row-${rIdx}`} className="flex flex-wrap gap-1.5">
                    {row.map((btn, bIdx) => (
                      <button
                        key={`tg-btn-${rIdx}-${bIdx}`}
                        type="button"
                        onClick={() => handleButtonClick(btn.callback_data, btn.text)}
                        className="flex-1 min-w-[120px] rounded-lg bg-[#2b5278] hover:bg-[#336391] active:bg-[#224363] px-3 py-2 text-center text-xs font-medium text-white transition-colors shadow-xs"
                      >
                        {btn.text}
                      </button>
                    ))}
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}
