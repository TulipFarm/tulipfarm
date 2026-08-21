import { Check, Copy, Download, ExternalLink, Image as ImageIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Modal } from "~/components/ui/modal";
import { Textarea } from "~/components/ui/textarea";
import { copyImageBlob } from "~/lib/clipboard";
import { buildIssueUrl, type CapturedScreenshot, downloadBlob } from "~/lib/report-bug";

export function ReportBugModal({
  open,
  onClose,
  screenshot,
}: {
  open: boolean;
  onClose: () => void;
  screenshot: CapturedScreenshot | null;
}) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);

  useEffect(() => {
    if (!open) {
      setTitle("");
      setDescription("");
      setCopied(false);
      setCopyFailed(false);
    }
  }, [open]);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  async function handleCopyScreenshot() {
    if (!screenshot) return;
    const ok = await copyImageBlob(screenshot.blob);
    if (ok) {
      setCopied(true);
      setCopyFailed(false);
    } else {
      setCopyFailed(true);
    }
  }

  function handleDownloadScreenshot() {
    if (!screenshot) return;
    downloadBlob(screenshot.blob);
  }

  function handleOpenIssue() {
    const url = buildIssueUrl({ title, description });
    window.open(url, "_blank", "noopener,noreferrer");
    onClose();
  }

  return (
    <Modal open={open} onClose={onClose} title="Report a bug" className="max-w-lg">
      <div className="flex flex-col gap-4">
        {screenshot ? (
          <div className="flex flex-col gap-2">
            <span className="text-xs font-medium text-muted-foreground">Screenshot preview</span>
            <div className="relative flex max-h-52 w-full items-center justify-center overflow-hidden rounded-md border border-border bg-muted/40 p-1">
              <img
                src={screenshot.dataUrl}
                alt="Captured screen preview"
                className="max-h-48 w-auto max-w-full rounded object-contain"
              />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleCopyScreenshot}
                className="h-7 text-xs"
              >
                {copied ? (
                  <>
                    <Check className="size-3.5 text-success" />
                    Copied to clipboard
                  </>
                ) : (
                  <>
                    <Copy className="size-3.5" />
                    Copy screenshot
                  </>
                )}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleDownloadScreenshot}
                className="h-7 text-xs"
              >
                <Download className="size-3.5" />
                Download PNG
              </Button>
              {copyFailed ? (
                <span className="text-[0.75rem] text-muted-foreground">
                  Direct clipboard copy unavailable. Please use Download PNG.
                </span>
              ) : null}
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-2 rounded-md border border-dashed border-border bg-muted/20 p-3 text-xs text-muted-foreground">
            <ImageIcon className="size-4 shrink-0" />
            <span>Screenshot not attached. You can still submit your bug report below.</span>
          </div>
        )}

        <div className="flex flex-col gap-1.5">
          <label htmlFor="report-bug-title" className="text-xs font-medium text-foreground">
            Title
          </label>
          <Input
            id="report-bug-title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Brief summary of the issue"
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="report-bug-description" className="text-xs font-medium text-foreground">
            Description
          </label>
          <Textarea
            id="report-bug-description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What happened, what did you expect, or steps to reproduce..."
            rows={4}
          />
        </div>

        <div className="flex items-center justify-end gap-2 pt-2">
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button type="button" size="sm" onClick={handleOpenIssue} className="gap-1.5">
            <ExternalLink className="size-3.5" />
            Open GitHub issue
          </Button>
        </div>
      </div>
    </Modal>
  );
}
