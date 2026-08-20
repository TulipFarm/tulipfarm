import { useState } from "react";
import { GuideSection } from "~/components/design-guide/guide-section";
import { FormStatus } from "~/components/form-status";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { CopyField } from "~/components/ui/copy-field";
import { Field } from "~/components/ui/field";
import { Input } from "~/components/ui/input";
import { LOADER_VARIANTS, LoadingState } from "~/components/ui/loading-state";
import { Panel, PanelEmpty, PanelRow } from "~/components/ui/panel";
import { Select } from "~/components/ui/select";
import { Textarea } from "~/components/ui/textarea";

function LoadingStateDemo() {
  const [drawKey, setDrawKey] = useState(0);

  return (
    <div className="grid gap-4">
      <div className="rounded-md border border-border bg-card p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">
            As mounted
          </p>
          <Button variant="secondary" size="sm" onClick={() => setDrawKey((n) => n + 1)}>
            Draw again
          </Button>
        </div>
        <div className="mt-4">
          <LoadingState key={drawKey} />
        </div>
        <p className="mt-4 max-w-2xl text-sm text-muted-foreground">
          With no props the pattern and the word are drawn once on mount and held for the life of
          the wait. Pass <code>label</code> wherever the copy has to say something specific.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {LOADER_VARIANTS.map((variant) => (
          <div key={variant} className="rounded-md border border-border bg-card p-4">
            <p className="font-mono text-xs text-muted-foreground">{variant}</p>
            <div className="mt-3">
              <LoadingState key={`${variant}-${drawKey}`} variant={variant} label="Sprouting" />
            </div>
          </div>
        ))}
      </div>

      <div className="rounded-md border border-border bg-card p-4">
        <p className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">
          Without the timer
        </p>
        <div className="mt-3">
          <LoadingState variant="drive" label="Saving" showElapsed={false} />
        </div>
        <p className="mt-3 max-w-2xl text-sm text-muted-foreground">
          Drop the timer on a surface that already reports duration, or on a wait short enough that
          a running clock is noise rather than reassurance.
        </p>
      </div>
    </div>
  );
}

export function ComponentSections() {
  return (
    <>
      <GuideSection
        id="loading"
        title="Loading state"
        description="A pixel grid, a shimmering word, and a live elapsed timer, for work whose duration is unknown."
      >
        <LoadingStateDemo />
        <p className="mt-4 max-w-2xl text-sm text-muted-foreground">
          The loop is allowed because it reports real state: something is in flight, and the timer
          in mono tabular figures says for how long. The drawn words all come from the field the
          product is named for and all describe growth, so a wait reads as something coming up
          rather than something running late. Under reduced motion the grid and the word freeze to a
          legible static state while the timer keeps ticking, since that is text rather than
          movement. The grid and the timer are <code>aria-hidden</code> inside a{" "}
          <code>role="status"</code> region that announces one stable line — a live region
          re-reading a tenth-second clock would be unusable.
        </p>
      </GuideSection>

      <GuideSection
        id="copy-field"
        title="Copyable values"
        description="A value the operator has to move somewhere else by hand: a webhook URL, an invite link."
      >
        <CopyField
          value="https://app.example.com/api/v1/hooks/integrations/slack"
          label="example"
        />
        <p className="mt-3 max-w-2xl text-sm text-muted-foreground">
          Always confirm the copy. <code>copyText</code> falls back to <code>execCommand</code> on
          insecure origins and can fail outright — a button that looks the same either way leaves
          someone pasting stale clipboard contents into a provider's form.
        </p>
      </GuideSection>

      <GuideSection
        id="hierarchy"
        title="Component hierarchy"
        description="Foundations feed primitives, primitives compose into reusable patterns, and features own domain behavior."
      >
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {[
            ["1", "Foundations", "Tokens, type, spacing, radius, motion"],
            ["2", "Primitives", "Buttons, fields, badges, overlays"],
            ["3", "Composites", "Shell, panels, forms, feedback"],
            ["4", "Features", "Domain data, behavior, and orchestration"],
          ].map(([step, title, detail]) => (
            <article key={step} className="rounded-md border border-border bg-card p-4">
              <span className="font-mono text-xs text-primary">{step}</span>
              <h3 className="mt-2 text-sm font-semibold">{title}</h3>
              <p className="mt-1 text-xs text-muted-foreground">{detail}</p>
            </article>
          ))}
        </div>
      </GuideSection>

      <GuideSection
        id="forms"
        title="Component index"
        description="Panel, Field and FormStatus are the shared composites every settings surface is assembled from. Visible labels and local help remain part of every field contract."
      >
        <Panel
          title="Panel"
          description="The titled container every settings and detail surface is built from. The title is an h2 — the top bar already names the page."
          footer={
            <div className="flex justify-end">
              <Button size="sm">Save changes</Button>
            </div>
          }
        >
          <form className="grid gap-5 sm:grid-cols-2" onSubmit={(event) => event.preventDefault()}>
            <Field label="Name">
              <Input placeholder="Quarterly planning" />
            </Field>
            <Field label="Status">
              <Select defaultValue="draft">
                <option value="draft">Draft</option>
                <option value="active">Active</option>
              </Select>
            </Field>
            <Field
              label="Description"
              help="Keep it concise and actionable."
              className="sm:col-span-2"
            >
              <Textarea placeholder="Describe the purpose and expected outcome." />
            </Field>
            <Field label="Website" error="Enter a full URL, including https://." required>
              <Input defaultValue="example.com" />
            </Field>
          </form>
        </Panel>

        <div className="mt-6 space-y-3">
          <FormStatus tone="error">Could not reach the API.</FormStatus>
          <FormStatus tone="success">Profile updated.</FormStatus>
        </div>

        <Panel
          title="Rows and empties"
          description="PanelRow separates stacked records; PanelEmpty states the absence in words rather than leaving a blank."
          className="mt-6"
          flush
        >
          <PanelRow>
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">Production deploy key</p>
              <p className="truncate text-xs text-muted-foreground">Added 12 Mar 2026</p>
            </div>
            <Badge variant="success">Active</Badge>
          </PanelRow>
          <PanelRow>
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">Staging deploy key</p>
              <p className="truncate text-xs text-muted-foreground">Added 4 Feb 2026</p>
            </div>
            <Badge>Unused</Badge>
          </PanelRow>
        </Panel>

        <Panel title="Nothing stored yet" className="mt-4">
          <PanelEmpty>No credentials are stored for this workspace.</PanelEmpty>
        </Panel>
      </GuideSection>
    </>
  );
}
