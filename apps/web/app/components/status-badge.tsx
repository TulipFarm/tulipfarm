import { Circle, CircleAlert, CircleCheck, CircleDot, TriangleAlert } from "lucide-react";
import { Badge } from "~/components/ui/badge";

export type StatusTone = "neutral" | "info" | "success" | "warning" | "danger";
export type Priority = "low" | "medium" | "high" | "critical";

const ICONS = {
  neutral: Circle,
  info: CircleDot,
  success: CircleCheck,
  warning: TriangleAlert,
  danger: CircleAlert,
} satisfies Record<StatusTone, typeof Circle>;

export function StatusBadge({ label, tone = "neutral" }: { label: string; tone?: StatusTone }) {
  const Icon = ICONS[tone];
  return (
    <Badge variant={tone}>
      <Icon className="size-3" aria-hidden />
      {label}
    </Badge>
  );
}

const PRIORITY_TONE: Record<Priority, StatusTone> = {
  low: "neutral",
  medium: "info",
  high: "warning",
  critical: "danger",
};

export function PriorityBadge({ priority }: { priority: Priority }) {
  return <StatusBadge label={priority} tone={PRIORITY_TONE[priority]} />;
}
