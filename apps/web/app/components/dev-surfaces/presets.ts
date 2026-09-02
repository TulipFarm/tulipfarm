import type { SurfaceArtifact } from "@tulipfarm/surface/client";

const CATALOG_REVISION = "tsp-1.2-data-display-1";

function presetArtifact(
  input: Omit<
    SurfaceArtifact,
    "catalogRevision" | "lineage" | "protocol" | "protocolVersion" | "revision"
  >
): SurfaceArtifact {
  return {
    protocol: "tsp",
    protocolVersion: "1.0",
    revision: 1,
    catalogRevision: CATALOG_REVISION,
    lineage: [],
    ...input,
  };
}

export interface SandboxPreset {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly artifact: SurfaceArtifact;
}

export const PRESETS: readonly SandboxPreset[] = [
  {
    id: "form-card",
    name: "Form Card",
    description: "Titled summary card with status and customer information.",
    artifact: presetArtifact({
      id: "form-card-specimen",
      component: { name: "Card", version: "1.0" },
      props: {
        title: "Customer Profile Card",
        status: "Active",
        body: "Acme Corp (Enterprise Tier), renewal date: Nov 2026. Account representative: Jane Doe.",
      },
      target: { channel: "web", surface: "chat" },
      audience: ["operator", "developer"],
      classification: "internal",
    }),
  },
  {
    id: "status-widget",
    name: "Status Widget",
    description: "Compact operational health badge.",
    artifact: presetArtifact({
      id: "status-widget-specimen",
      component: { name: "Status", version: "1.0" },
      props: {
        label: "Operational · All systems healthy",
        tone: "positive",
      },
      target: { channel: "web", surface: "chat" },
      audience: ["developer"],
      classification: "internal",
    }),
  },
  {
    id: "table-artifact",
    name: "Table Artifact",
    description: "Multi-row tabular record artifact with column headers.",
    artifact: presetArtifact({
      id: "table-artifact-specimen",
      component: { name: "RecordTable", version: "1.0" },
      props: {
        columns: ["service", "status", "latency", "uptime"],
        records: [
          { service: "API Gateway", status: "Healthy", latency: "24ms", uptime: "99.99%" },
          { service: "Worker Engine", status: "Healthy", latency: "42ms", uptime: "99.95%" },
          { service: "PostgreSQL Primary", status: "Healthy", latency: "5ms", uptime: "100.0%" },
          { service: "Search Indexer", status: "Healthy", latency: "18ms", uptime: "99.98%" },
        ],
      },
      target: { channel: "web", surface: "chat" },
      audience: ["developer"],
      classification: "internal",
    }),
  },
  {
    id: "interactive-form",
    name: "Interactive Form",
    description: "Rich multi-field input form with validation and submit action.",
    artifact: presetArtifact({
      id: "interactive-form-specimen",
      component: { name: "Form", version: "1.0" },
      props: {
        title: "Create Infrastructure Ticket",
        fields: [
          { name: "title", label: "Ticket Title", input: "text", required: true },
          {
            name: "environment",
            label: "Environment",
            input: "select",
            options: ["production", "staging", "development"],
            required: true,
          },
          { name: "contactEmail", label: "Contact Email", input: "email", required: true },
          { name: "urgent", label: "High Priority Dispatch", input: "checkbox" },
          { name: "description", label: "Issue Description", input: "textarea" },
        ],
        submit: "Submit Form",
        action: { event: "ticket.create" },
      },
      target: { channel: "web", surface: "chat" },
      audience: ["developer", "operator"],
      classification: "internal",
    }),
  },
  {
    id: "error-banner",
    name: "Error Banner",
    description: "Warning and error alert banner for operational incidents.",
    artifact: presetArtifact({
      id: "error-banner-specimen",
      component: { name: "Alert", version: "1.0" },
      props: {
        title: "Deployment Warning",
        message:
          "Production database connection pool saturation reached 85%. Automatic scaling initiated.",
        severity: "warning",
      },
      target: { channel: "web", surface: "chat" },
      audience: ["developer"],
      classification: "internal",
    }),
  },
  {
    id: "choices-actions",
    name: "Choices & Actions",
    description: "Mutually exclusive decision choices with confidence and recommendation.",
    artifact: presetArtifact({
      id: "choices-specimen",
      component: { name: "Choices", version: "1.0" },
      props: {
        question: "Choose a deployment strategy for the new service version:",
        choices: [
          {
            label: "Canary Rollout (10% -> 100%)",
            value: "canary",
            detail: "Gradually shift traffic over 30 minutes with anomaly rollback.",
            confidence: "high",
          },
          {
            label: "Blue/Green Instant Cutover",
            value: "blue_green",
            detail: "Deploy isolated cluster and swap DNS pointer immediately.",
            confidence: "medium",
          },
          {
            label: "Rolling Update",
            value: "rolling",
            detail: "Replace container instances sequentially.",
            confidence: "low",
          },
        ],
        recommend: "canary",
        action: { event: "deployment.strategy.select" },
      },
      target: { channel: "web", surface: "chat" },
      audience: ["developer"],
      classification: "internal",
    }),
  },
  {
    id: "metrics-kpis",
    name: "Metric & KPIs",
    description: "Key performance indicator metrics with trend directions and captions.",
    artifact: presetArtifact({
      id: "metric-specimen",
      component: { name: "Metric", version: "1.0" },
      props: {
        cells: [
          {
            label: "Monthly Recurring Revenue",
            value: "$142,500",
            delta: { value: "+12.4%", direction: "up", label: "vs last month" },
            caption: "Active subscriptions",
          },
          {
            label: "Active Workspaces",
            value: "1,248",
            delta: { value: "+84", direction: "up" },
            caption: "30-day trailing",
          },
          {
            label: "Median API Latency",
            value: "45ms",
            delta: { value: "-8ms", direction: "down" },
            caption: "p50 response time",
          },
        ],
      },
      target: { channel: "web", surface: "chat" },
      audience: ["developer", "operator"],
      classification: "internal",
    }),
  },
  {
    id: "timeline",
    name: "Timeline Sequence",
    description: "Ordered chronological event log with timestamps and statuses.",
    artifact: presetArtifact({
      id: "timeline-specimen",
      component: { name: "Timeline", version: "1.0" },
      props: {
        entries: [
          {
            label: "Deployment Triggered",
            timestamp: "14:20:00 UTC",
            description: "CI pipeline dispatched build v2.4.1",
            status: "Completed",
          },
          {
            label: "Database Migration",
            timestamp: "14:21:15 UTC",
            description: "Applied schema migration 0042_surfaces.sql",
            status: "Success",
          },
          {
            label: "Traffic Cutover",
            timestamp: "14:22:30 UTC",
            description: "Routed 100% of ingress traffic to active cluster",
            status: "Live",
          },
        ],
      },
      target: { channel: "web", surface: "chat" },
      audience: ["developer"],
      classification: "internal",
    }),
  },
] as const;

export const DEFAULT_PRESET = PRESETS[0];
