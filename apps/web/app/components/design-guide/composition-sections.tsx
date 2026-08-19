import { Check, Search, Settings } from "lucide-react";
import { Composer } from "~/components/chat/composer";
import { Transcript } from "~/components/chat/transcript";
import { GuideSection } from "~/components/design-guide/guide-section";
import { FileList } from "~/components/files/file-list";
import type { ChatMessage } from "~/lib/chat/types";

/**
 * A finished reply carrying a receipt. Auto is a request, not an outcome, so the receipt names the
 * rung it resolved to — which is also what "Try harder" escalates from.
 */
const TRANSCRIPT_MESSAGES: ChatMessage[] = [
  {
    id: "guide-user",
    role: "user",
    sealed: true,
    parts: [{ kind: "text", text: "Which invoices are overdue?" }],
  },
  {
    id: "guide-assistant",
    role: "assistant",
    sealed: true,
    parts: [{ kind: "text", text: "Three invoices are overdue by more than 30 days." }],
    receipt: {
      modelId: "claude-sonnet-5",
      effortPreset: "auto",
      effortApplied: "balanced",
      modelCallLatencyMs: 1240,
    },
    sourceTurn: { text: "Which invoices are overdue?", options: { model: "auto" } },
  },
];

const GUIDE_FILES = [
  {
    id: "file_1",
    filename: "storefront.png",
    mediaType: "image/png",
    sizeBytes: 184_320,
    createdAt: "2026-01-02T09:00:00.000Z",
    owner: "user_1",
    origin: "uploaded" as const,
    sourceChatId: "conv_1",
  },
  {
    id: "file_2",
    filename: "q1-summary.pdf",
    mediaType: "application/pdf",
    sizeBytes: 51_200,
    createdAt: "2026-01-03T09:00:00.000Z",
    owner: "user_1",
    origin: "generated" as const,
    sourceChatId: null,
  },
];

export function CompositionSections() {
  return (
    <>
      <GuideSection
        id="composition"
        title="Composition patterns"
        description="Panels, navigation, and feedback use the same spacing and hierarchy."
      >
        <div className="mb-6 overflow-hidden rounded-md border border-border bg-background px-4 py-4">
          <Transcript
            messages={TRANSCRIPT_MESSAGES}
            status="idle"
            onApprove={() => undefined}
            onTryHarder={() => undefined}
          />
        </div>
        <div className="mb-6 overflow-hidden rounded-md border border-border bg-background">
          <Composer
            onSend={() => undefined}
            activeAgent={{ name: "InventoryPlanner", label: "Inventory planner" }}
            suggestions={[
              {
                id: "clarify",
                label: "Clarify the problem",
                prompt: "Help me clarify the problem before we start.",
              },
              {
                id: "plan",
                label: "Create a plan",
                prompt: "Create a practical plan with clear next steps.",
              },
            ]}
          />
        </div>
        <div className="mb-6">
          <h3 className="mb-2 text-sm font-semibold">Files library rows</h3>
          <p className="mb-3 text-sm text-muted-foreground">
            One row shape carries both a screenshot and a document. Origin is an icon plus a word,
            never a tint alone, so who made a File survives a greyscale screen.
          </p>
          <FileList files={GUIDE_FILES} viewerId="user_1" onPreview={() => undefined} />
        </div>
        <div className="grid gap-4 lg:grid-cols-3">
          <article className="rounded-md border border-border bg-card">
            <header className="flex items-center gap-2 border-b border-border px-4 py-3">
              <Search className="size-4 text-muted-foreground" aria-hidden />
              <h3 className="text-sm font-semibold">Search results</h3>
            </header>
            <div className="px-4 py-5 text-sm text-muted-foreground">No matching Records yet.</div>
          </article>
          <article className="rounded-md border border-border bg-card">
            <header className="flex items-center gap-2 border-b border-border px-4 py-3">
              <Check className="size-4 text-status-success" aria-hidden />
              <h3 className="text-sm font-semibold">Ready</h3>
            </header>
            <div className="px-4 py-5 text-sm text-muted-foreground">
              All systems are available.
            </div>
          </article>
          <article className="rounded-md border border-border bg-card">
            <header className="flex items-center gap-2 border-b border-border px-4 py-3">
              <Settings className="size-4 text-muted-foreground" aria-hidden />
              <h3 className="text-sm font-semibold">Configuration</h3>
            </header>
            <div className="px-4 py-5 text-sm text-muted-foreground">
              Changes apply after validation.
            </div>
          </article>
        </div>
      </GuideSection>

      <GuideSection
        id="layout"
        title="Layout system"
        description="A 56px product rail, 256px context panel, and 52px top bar adapt at 768px and 1024px. All three columns share the same 52px header row."
      >
        <div className="flex h-32 overflow-hidden rounded-md border border-border text-xs">
          <div className="flex w-14 shrink-0 flex-col border-r border-border bg-background">
            <div className="flex h-[52px] items-center justify-center border-b border-border font-mono">
              56
            </div>
            <div className="flex-1" />
          </div>
          <div className="flex w-64 shrink-0 flex-col border-r border-border bg-sidebar">
            <div className="flex h-[52px] items-center border-b border-border px-4 font-mono">
              256
            </div>
            <div className="flex-1" />
          </div>
          <div className="min-w-0 flex-1 bg-card">
            <div className="flex h-[52px] items-center border-b border-border px-4 font-mono">
              52
            </div>
            <div className="p-4 text-muted-foreground">Work surface</div>
          </div>
        </div>
      </GuideSection>
    </>
  );
}
