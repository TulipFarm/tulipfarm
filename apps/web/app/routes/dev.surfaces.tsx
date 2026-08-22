import type { MetaFunction } from "@remix-run/react";
import {
  type SurfaceArtifact,
  type SurfaceRenderIssue,
  validateSurfaceArtifact,
} from "@tulipfarm/surface";
import { SurfaceView } from "@tulipfarm/surface-web";
import {
  AlertTriangle,
  Boxes,
  Eye,
  Laptop,
  Layers,
  RotateCcw,
  Smartphone,
  Tablet,
} from "lucide-react";
import { useId, useMemo, useState } from "react";
import { EventInspector, type LoggedInteraction } from "~/components/dev-surfaces/event-inspector";
import { JsonEditor } from "~/components/dev-surfaces/json-editor";
import { DEFAULT_PRESET, PRESETS } from "~/components/dev-surfaces/presets";
import { GitHubPreview } from "~/components/dev-surfaces/renderers/github-preview";
import { SlackPreview } from "~/components/dev-surfaces/renderers/slack-preview";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Select } from "~/components/ui/select";
import { randomUUID } from "~/lib/uuid";

export const meta: MetaFunction = () => [
  { title: "Tulip Surface Protocol Sandbox · tulipfarm" },
  {
    name: "description",
    content: "Live multi-platform renderer workbench for Tulip Surface Protocol (TSP) artifacts.",
  },
];

type RendererTab = "react" | "slack" | "github";
type ViewportSize = "desktop" | "tablet" | "mobile";

export default function DevelopmentSurfacesRoute() {
  const [selectedPresetId, setSelectedPresetId] = useState<string>(DEFAULT_PRESET.id);
  const [activeTab, setActiveTab] = useState<RendererTab>("react");
  const [viewport, setViewport] = useState<ViewportSize>("desktop");
  const [events, setEvents] = useState<readonly LoggedInteraction[]>([]);

  // Find active preset object
  const activePreset = useMemo(
    () => PRESETS.find((p) => p.id === selectedPresetId) ?? DEFAULT_PRESET,
    [selectedPresetId]
  );

  // Raw JSON state
  const [jsonText, setJsonText] = useState<string>(() =>
    JSON.stringify(DEFAULT_PRESET.artifact, null, 2)
  );

  // Parse and validate live JSON
  const { parsedArtifact, syntaxError, validationIssues, isValid } = useMemo(() => {
    try {
      const parsed = JSON.parse(jsonText) as SurfaceArtifact;
      const issues: readonly SurfaceRenderIssue[] = validateSurfaceArtifact(parsed);
      return {
        parsedArtifact: issues.length === 0 ? parsed : null,
        syntaxError: null,
        validationIssues: issues,
        isValid: issues.length === 0,
      };
    } catch (err) {
      return {
        parsedArtifact: null,
        syntaxError: err instanceof Error ? err.message : String(err),
        validationIssues: [] as readonly SurfaceRenderIssue[],
        isValid: false,
      };
    }
  }, [jsonText]);

  // Switch preset
  const handleSelectPreset = (presetId: string) => {
    setSelectedPresetId(presetId);
    const target = PRESETS.find((p) => p.id === presetId);
    if (target) {
      setJsonText(JSON.stringify(target.artifact, null, 2));
    }
  };

  // Reset current preset
  const handleResetPreset = () => {
    setJsonText(JSON.stringify(activePreset.artifact, null, 2));
  };

  // Handle surface interaction from any renderer
  const handleInteraction = (actionId: string, inputPayload: Record<string, unknown>) => {
    const componentName = parsedArtifact?.component.name ?? "unknown";
    const componentId = parsedArtifact?.id ?? "unknown";
    const targetStr = parsedArtifact
      ? `${parsedArtifact.target.channel}:${parsedArtifact.target.surface}`
      : "web:chat";

    const newEvent: LoggedInteraction = {
      id: `evt-${randomUUID()}`,
      timestamp: new Date().toISOString(),
      actionId,
      componentId: `${componentName} (${componentId})`,
      target: targetStr,
      payload: inputPayload,
    };

    setEvents((prev) => [newEvent, ...prev]);
  };

  const presetSelectId = useId();

  return (
    <div className="h-full min-h-0 overflow-y-auto">
      <div className="mx-auto w-full max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
        {/* Top Header */}
        <header className="mb-6 flex flex-col gap-2 border-b border-border pb-6">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="primary">TSP v1.0</Badge>
            <Badge variant="neutral">Dev Sandbox</Badge>
            <Badge variant="info">Multi-Renderer</Badge>
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
            Tulip Surface Protocol Sandbox
          </h1>
          <p className="max-w-3xl text-sm text-muted-foreground">
            Live testing environment for rendering dynamic AI-generated user interfaces across
            native React web surfaces, Slack Block Kit, and GitHub Check Run/Comment cards.
          </p>
        </header>

        {/* Control Bar: Preset Selector & Viewport Selector */}
        <div className="mb-6 flex flex-wrap items-center justify-between gap-4 rounded-lg border border-border bg-card p-4 shadow-xs">
          <div className="flex flex-wrap items-center gap-3">
            <label
              htmlFor={presetSelectId}
              className="text-xs font-semibold text-foreground shrink-0"
            >
              Template Preset:
            </label>
            <div className="w-56 sm:w-64">
              <Select
                id={presetSelectId}
                aria-label="Template preset selector"
                value={selectedPresetId}
                onChange={(e) => handleSelectPreset(e.target.value)}
              >
                {PRESETS.map((preset) => (
                  <option key={preset.id} value={preset.id}>
                    {preset.name}
                  </option>
                ))}
              </Select>
            </div>
            <span className="text-xs text-muted-foreground hidden lg:inline">
              {activePreset.description}
            </span>
          </div>

          {/* Viewport Simulation Selector */}
          <div className="flex items-center gap-1 rounded-md border border-border bg-muted/40 p-0.5 text-xs">
            <button
              type="button"
              onClick={() => setViewport("desktop")}
              className={`flex items-center gap-1 rounded px-2.5 py-1 font-medium transition-colors ${
                viewport === "desktop"
                  ? "bg-background text-foreground shadow-xs"
                  : "text-muted-foreground hover:text-foreground"
              }`}
              title="Desktop 100%"
            >
              <Laptop className="size-3.5" />
              <span className="hidden sm:inline">Desktop</span>
            </button>
            <button
              type="button"
              onClick={() => setViewport("tablet")}
              className={`flex items-center gap-1 rounded px-2.5 py-1 font-medium transition-colors ${
                viewport === "tablet"
                  ? "bg-background text-foreground shadow-xs"
                  : "text-muted-foreground hover:text-foreground"
              }`}
              title="Tablet 768px"
            >
              <Tablet className="size-3.5" />
              <span className="hidden sm:inline">Tablet</span>
            </button>
            <button
              type="button"
              onClick={() => setViewport("mobile")}
              className={`flex items-center gap-1 rounded px-2.5 py-1 font-medium transition-colors ${
                viewport === "mobile"
                  ? "bg-background text-foreground shadow-xs"
                  : "text-muted-foreground hover:text-foreground"
              }`}
              title="Mobile 375px"
            >
              <Smartphone className="size-3.5" />
              <span className="hidden sm:inline">Mobile (375px)</span>
            </button>
          </div>
        </div>

        {/* Preset Quick Chips Bar */}
        <div className="mb-6 flex flex-wrap items-center gap-1.5">
          <span className="text-xs font-medium text-muted-foreground mr-1">Presets:</span>
          {PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => handleSelectPreset(p.id)}
              className={`rounded-md border px-2.5 py-1 text-xs font-medium transition-colors ${
                p.id === selectedPresetId
                  ? "border-primary bg-primary/10 text-primary"
                  : "border-border bg-card text-muted-foreground hover:bg-accent hover:text-foreground"
              }`}
            >
              {p.name}
            </button>
          ))}
        </div>

        {/* Main Split Grid */}
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
          {/* Left Column: Multi-Renderer & Event Inspector (7 cols) */}
          <div className="flex flex-col gap-6 lg:col-span-7">
            {/* Renderer Container Card */}
            <section
              aria-label="Multi-renderer surface preview"
              className="rounded-lg border border-border bg-card shadow-xs overflow-hidden"
            >
              {/* Multi-Renderer Tabs Bar */}
              <div
                role="tablist"
                aria-label="Surface renderer targets"
                className="flex flex-wrap items-center gap-1 border-b border-border bg-muted/30 p-2"
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={activeTab === "react"}
                  onClick={() => setActiveTab("react")}
                  className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors focus-visible:ring-2 ${
                    activeTab === "react"
                      ? "bg-background text-foreground shadow-xs font-semibold"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  <Layers className="size-3.5 text-primary" />
                  React (Web)
                </button>

                <button
                  type="button"
                  role="tab"
                  aria-selected={activeTab === "slack"}
                  onClick={() => setActiveTab("slack")}
                  className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors focus-visible:ring-2 ${
                    activeTab === "slack"
                      ? "bg-background text-foreground shadow-xs font-semibold"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  <Boxes className="size-3.5 text-[#4A154B]" />
                  Slack (Block Kit)
                </button>

                <button
                  type="button"
                  role="tab"
                  aria-selected={activeTab === "github"}
                  onClick={() => setActiveTab("github")}
                  className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors focus-visible:ring-2 ${
                    activeTab === "github"
                      ? "bg-background text-foreground shadow-xs font-semibold"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  <Eye className="size-3.5 text-foreground" />
                  GitHub
                </button>
              </div>

              {/* Preview Viewport Canvas */}
              <div className="p-4 sm:p-6 bg-muted/10 min-h-[380px] flex flex-col justify-start">
                <div
                  className={`w-full transition-all duration-200 ${
                    viewport === "mobile"
                      ? "max-w-[375px] mx-auto border-x border-dashed border-border px-2 py-4 rounded bg-background shadow-xs"
                      : viewport === "tablet"
                        ? "max-w-[768px] mx-auto border-x border-dashed border-border px-4 py-4 rounded bg-background shadow-xs"
                        : ""
                  }`}
                >
                  {parsedArtifact ? (
                    activeTab === "react" ? (
                      <div data-testid="react-renderer-preview" className="space-y-4">
                        <SurfaceView
                          artifact={parsedArtifact}
                          onInteraction={(handle, payload) => handleInteraction(handle, payload)}
                          actionHandleFor={(action) => action.event}
                        />
                      </div>
                    ) : activeTab === "slack" ? (
                      <div data-testid="slack-renderer-preview">
                        <SlackPreview
                          artifact={parsedArtifact}
                          onInteraction={(actionId, payload) =>
                            handleInteraction(actionId, payload)
                          }
                        />
                      </div>
                    ) : (
                      <div data-testid="github-renderer-preview">
                        <GitHubPreview
                          artifact={parsedArtifact}
                          onInteraction={(actionId, payload) =>
                            handleInteraction(actionId, payload)
                          }
                        />
                      </div>
                    )
                  ) : (
                    /* ErrorState Fallback */
                    <div
                      role="alert"
                      data-testid="schema-error-state"
                      className="flex flex-col items-center justify-center rounded-lg border border-status-danger/40 bg-status-danger/10 p-8 text-center"
                    >
                      <AlertTriangle className="size-8 text-status-danger" />
                      <h3 className="mt-2 text-sm font-semibold text-status-danger">
                        Schema Error Fallback: Invalid Surface Artifact
                      </h3>
                      <p className="mt-1 max-w-md text-xs text-muted-foreground">
                        {syntaxError
                          ? `JSON Syntax Error: ${syntaxError}`
                          : validationIssues.length > 0
                            ? `The current payload has ${validationIssues.length} schema validation ${
                                validationIssues.length === 1 ? "issue" : "issues"
                              }. Correct the JSON or restore a valid preset.`
                            : "Payload is empty or missing required Tulip Surface Protocol fields."}
                      </p>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={handleResetPreset}
                        className="mt-4 gap-1.5 text-xs"
                      >
                        <RotateCcw className="size-3.5" />
                        Restore Valid Preset
                      </Button>
                    </div>
                  )}
                </div>
              </div>
            </section>

            {/* Event Inspector Panel */}
            <EventInspector events={events} onClear={() => setEvents([])} />
          </div>

          {/* Right Column: Raw JSON Editor & Metadata (5 cols) */}
          <div className="flex flex-col gap-6 lg:col-span-5">
            {/* JSON Payload Editor */}
            <section
              aria-label="Raw JSON Payload Editor"
              className="rounded-lg border border-border bg-card p-4 shadow-xs"
            >
              <JsonEditor
                value={jsonText}
                onChange={setJsonText}
                onResetPreset={handleResetPreset}
                validationIssues={validationIssues}
                syntaxError={syntaxError}
                isValid={isValid}
              />
            </section>

            {/* Artifact Metadata / Catalog Card */}
            <section
              aria-label="Artifact metadata and catalog info"
              className="rounded-lg border border-border bg-card p-4 text-xs text-muted-foreground shadow-xs"
            >
              <div className="flex items-center justify-between border-b border-border pb-2">
                <span className="font-semibold text-foreground">Active Artifact Specification</span>
                <Badge variant="neutral">TSP Catalog 1.2</Badge>
              </div>
              {parsedArtifact ? (
                <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2">
                  <div>
                    <dt className="text-muted-foreground">Component</dt>
                    <dd className="font-semibold text-foreground font-mono">
                      {parsedArtifact.component.name}@{parsedArtifact.component.version}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">Artifact ID</dt>
                    <dd className="font-semibold text-foreground font-mono">{parsedArtifact.id}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">Target Channel</dt>
                    <dd className="font-semibold text-foreground font-mono">
                      {parsedArtifact.target.channel}:{parsedArtifact.target.surface}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">Classification</dt>
                    <dd className="font-semibold text-foreground capitalize">
                      {parsedArtifact.classification}
                    </dd>
                  </div>
                  <div className="col-span-2">
                    <dt className="text-muted-foreground">Audience</dt>
                    <dd className="font-semibold text-foreground font-mono">
                      [{parsedArtifact.audience.join(", ")}]
                    </dd>
                  </div>
                </dl>
              ) : (
                <p className="mt-2 text-status-warning">
                  Specifications unavailable for invalid payload.
                </p>
              )}
            </section>
          </div>
        </div>
      </div>
    </div>
  );
}
