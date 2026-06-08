import {
  BookOpen,
  Bot,
  Boxes,
  CheckCheck,
  type LucideIcon,
  MessageSquare,
  Plug,
  Puzzle,
  Settings,
  Workflow,
} from "lucide-react";
import type { BadgeKey } from "~/lib/badges";

export type NavGroup = "Workspace" | "System";

export type NavItem = {
  to: string;
  label: string;
  icon: LucideIcon;
  group: NavGroup;
  end?: boolean;
  badgeKey?: BadgeKey;
};

/*
 * Sidebar sections for V1 (UI-V1-003). Order is canonical, split into two quiet groups for
 * scannability. There is deliberately NO "Apps" section — micro apps are deferred (AC-V1-003).
 */
export const navItems: NavItem[] = [
  { to: "/", label: "Chat", icon: MessageSquare, group: "Workspace", end: true },
  { to: "/resources", label: "Resources", icon: Boxes, group: "Workspace" },
  { to: "/agents", label: "Agents", icon: Bot, group: "Workspace" },
  { to: "/skills", label: "Skills", icon: Puzzle, group: "Workspace" },
  { to: "/routines", label: "Routines", icon: Workflow, group: "Workspace" },
  {
    to: "/approvals",
    label: "Approvals",
    icon: CheckCheck,
    group: "Workspace",
    badgeKey: "approvals",
  },
  { to: "/knowledge", label: "Knowledge", icon: BookOpen, group: "Workspace" },
  { to: "/integrations", label: "Integrations", icon: Plug, group: "System" },
  { to: "/settings", label: "Settings", icon: Settings, group: "System" },
];

// Canonical group order for rendering.
export const navGroups: NavGroup[] = ["Workspace", "System"];
