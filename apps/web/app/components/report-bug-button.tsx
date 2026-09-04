import { useState } from "react";
import { Bug } from "~/components/icons";
import { ReportBugModal } from "~/components/report-bug-modal";
import { Button } from "~/components/ui/button";
import { Tooltip } from "~/components/ui/tooltip";
import { type CapturedScreenshot, captureScreenshot } from "~/lib/report-bug";

export function ReportBugButton({ iconOnly = true }: { iconOnly?: boolean }) {
  const [open, setOpen] = useState(false);
  const [screenshot, setScreenshot] = useState<CapturedScreenshot | null>(null);
  const [capturing, setCapturing] = useState(false);

  async function handleClick() {
    if (capturing) return;
    setCapturing(true);
    try {
      const shot = await captureScreenshot();
      setScreenshot(shot);
      setOpen(true);
    } catch {
      setScreenshot(null);
      setOpen(true);
    } finally {
      setCapturing(false);
    }
  }

  const trigger = (
    <Button
      type="button"
      variant="ghost"
      size={iconOnly ? "icon" : "sm"}
      onClick={handleClick}
      disabled={capturing}
      aria-label="Report a bug"
      className={
        iconOnly
          ? "size-8 rounded-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          : "gap-2 rounded-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      }
    >
      <Bug className="size-4" aria-hidden />
      {!iconOnly ? <span>Report a bug</span> : null}
    </Button>
  );

  return (
    <>
      <Tooltip content="Report a bug">{trigger}</Tooltip>
      <ReportBugModal
        open={open}
        onClose={() => {
          setOpen(false);
          setScreenshot(null);
        }}
        screenshot={screenshot}
      />
    </>
  );
}
