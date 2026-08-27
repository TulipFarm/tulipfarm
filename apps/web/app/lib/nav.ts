import {
  Activity,
  BookOpen,
  Bot,
  Boxes,
  Brain,
  Building2,
  Cpu,
  Flower2,
  Gauge,
  History,
  Inbox,
  Info,
  KeyRound,
  type LucideIcon,
  MessageSquare,
  Palette,
  Plug,
  Puzzle,
  Settings,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  UserRound,
  Users,
  Workflow,
} from "lucide-react";

export type ProductMode = "chat" | "farm" | "build" | "knowledge" | "operate" | "settings";

export type NavItem = {
  to: string;
  label: string;
  icon: LucideIcon;
  badge?: boolean;
  devOnly?: boolean;
  /**
   * The one line the top bar cannot say. Rendered by the section shell instead of a second page
   * title, so a page is named once.
   */
  description?: string;
  wide?: boolean;
};

export type NavSection = {
  heading?: string;
  items: NavItem[];
};

export type NavigationVisibility = {
  isDev: boolean;
  visiblePaths?: readonly string[];
};

/*
 * One source of truth for a mode's identity. The rail, the context-panel header, and the top-bar
 * breadcrumb all read from here, so a mode can never render under another mode's icon.
 */
export const MODE_META: Record<ProductMode, { label: string; to: string; icon: LucideIcon }> = {
  chat: { label: "Chat", to: "/", icon: MessageSquare },
  farm: { label: "Farm", to: "/farm", icon: Flower2 },
  build: { label: "Build", to: "/resources", icon: Boxes },
  knowledge: { label: "Knowledge", to: "/knowledge", icon: BookOpen },
  operate: { label: "Operate", to: "/inbox", icon: Activity },
  settings: { label: "Settings", to: "/settings", icon: Settings },
};

export const PRIMARY_MODES = ["chat", "build", "knowledge", "operate"] as const;

/**
 * Modes whose page is the whole surface. They own the full width and publish their own navigation,
 * so a context panel beside them would only repeat what the page already shows.
 */
export const FULL_BLEED_MODES: readonly ProductMode[] = ["farm"];

export function hasContextPanel(mode: ProductMode): boolean {
  return !FULL_BLEED_MODES.includes(mode);
}

export const MODE_SECTIONS: Record<"build" | "operate" | "settings", NavSection[]> = {
  build: [
    {
      items: [
        { to: "/resources", label: "Resources", icon: Boxes },
        { to: "/agents", label: "Agents", icon: Bot },
        { to: "/skills", label: "Skills", icon: Puzzle },
        { to: "/routines", label: "Routines", icon: Workflow },
      ],
    },
  ],
  operate: [
    {
      heading: "Work",
      items: [
        { to: "/inbox", label: "Inbox", icon: Inbox, badge: true },
        { to: "/runs", label: "Runs", icon: Activity },
        {
          to: "/business/activities",
          label: "Activities",
          icon: History,
          description:
            "Everything that happened in this workspace: records, chats, jobs, and deliveries.",
          wide: true,
        },
      ],
    },
    {
      heading: "Health",
      items: [
        { to: "/operations", label: "Operations", icon: ShieldAlert },
        {
          to: "/business/observability",
          label: "Observability",
          icon: Gauge,
          description: "What your agents are spending and doing: cost, tokens, and reliability.",
          wide: true,
        },
      ],
    },
    {
      heading: "Business",
      items: [
        {
          to: "/business/profile",
          label: "Business profile",
          icon: Building2,
          description:
            "Who this workspace is for. Agents read these values as context on every turn.",
        },
        {
          to: "/business/models",
          label: "Models",
          icon: Cpu,
          description:
            "Which models back each effort preset, and what happens when the first one is unavailable.",
        },
        {
          to: "/business/secrets",
          label: "Secrets",
          icon: KeyRound,
          description: "Provider credentials and custom secrets. Values are never shown again.",
        },
        {
          to: "/integrations",
          label: "Integrations",
          icon: Plug,
          description:
            "Connect the tools your business already runs on, and see what each one lets agents reach.",
        },
        {
          to: "/business/soul",
          label: "Soul",
          icon: Sparkles,
          description: "Browse the version-controlled repository your workspace is defined in.",
          wide: true,
        },
        {
          to: "/business/guardrails",
          label: "Guardrails",
          icon: ShieldCheck,
          description: "Limits every agent is checked against, before and after it acts.",
        },
        {
          to: "/business/access",
          label: "People & access",
          icon: Users,
          description:
            "Invite people, turn accounts off, and decide what each person is allowed to do.",
          wide: true,
        },
        {
          to: "/business/about",
          label: "About",
          icon: Info,
          description: "Which version this instance runs, and whether a newer one exists.",
        },
      ],
    },
  ],
  settings: [
    {
      items: [
        {
          to: "/settings/profile",
          label: "Profile",
          icon: UserRound,
          description: "Your display name, and the account details an admin manages for you.",
        },
        {
          to: "/settings/appearance",
          label: "Appearance",
          icon: Palette,
          description: "How TulipFarm looks on this device.",
        },
        {
          to: "/settings/auth",
          label: "Auth",
          icon: ShieldCheck,
          description: "Your password and the API tokens that act on your behalf.",
        },
        {
          to: "/settings/instructions",
          label: "Custom instructions",
          icon: Brain,
          description: "Standing guidance every assistant follows, written by you.",
        },
        { to: "/design-guide", label: "Design guide", icon: Sparkles, devOnly: true },
      ],
    },
  ],
};

export function visibleSections(
  mode: "build" | "operate" | "settings",
  { isDev, visiblePaths }: NavigationVisibility
): NavSection[] {
  return MODE_SECTIONS[mode]
    .map((section) => ({
      ...section,
      items: section.items.filter(
        (item) =>
          (visiblePaths === undefined || visiblePaths.includes(item.to)) && (!item.devOnly || isDev)
      ),
    }))
    .filter((section) => section.items.length > 0);
}

export function visibleModes({ isDev, visiblePaths }: NavigationVisibility): ProductMode[] {
  const visible = ["chat"] as ProductMode[];
  if (visibleSections("build", { isDev, visiblePaths }).length > 0) visible.push("build");
  if (visiblePaths === undefined || visiblePaths.includes("/knowledge")) visible.push("knowledge");
  if (visibleSections("operate", { isDev, visiblePaths }).length > 0) visible.push("operate");
  if (visiblePaths === undefined || visiblePaths.includes("/farm")) visible.push("farm");
  if (visibleSections("settings", { isDev, visiblePaths }).length > 0) visible.push("settings");
  return visible;
}

export function destinationForMode(mode: ProductMode, visibility: NavigationVisibility): string {
  if (mode !== "build" && mode !== "operate" && mode !== "settings") {
    return MODE_META[mode].to;
  }
  return (
    visibleSections(mode, visibility).flatMap((section) => section.items)[0]?.to ??
    MODE_META[mode].to
  );
}

export function modeForPath(pathname: string): ProductMode {
  if (pathname.startsWith("/settings") || pathname.startsWith("/design-guide")) return "settings";
  if (pathname.startsWith("/farm")) return "farm";
  if (pathname.startsWith("/knowledge")) return "knowledge";
  if (
    pathname.startsWith("/business") ||
    pathname.startsWith("/admin") ||
    pathname.startsWith("/inbox") ||
    pathname.startsWith("/runs") ||
    pathname.startsWith("/integrations") ||
    pathname.startsWith("/operations")
  ) {
    return "operate";
  }
  if (
    pathname.startsWith("/resources") ||
    pathname.startsWith("/agents") ||
    pathname.startsWith("/skills") ||
    pathname.startsWith("/routines")
  ) {
    return "build";
  }
  return "chat";
}

const PAGE_META: Array<{ prefix: string; label: string; icon: LucideIcon }> = [
  { prefix: "/farm", label: "Farm", icon: Flower2 },
  { prefix: "/business/activities", label: "Activities", icon: History },
  { prefix: "/business/observability", label: "Observability", icon: Gauge },
  { prefix: "/business/profile", label: "Business profile", icon: Building2 },
  { prefix: "/business/models", label: "Models", icon: Cpu },
  { prefix: "/business/secrets", label: "Secrets", icon: KeyRound },
  { prefix: "/business/soul", label: "Soul", icon: Sparkles },
  { prefix: "/business/guardrails", label: "Guardrails", icon: ShieldCheck },
  { prefix: "/business/people", label: "People & access", icon: Users },
  { prefix: "/business/access", label: "People & access", icon: Users },
  { prefix: "/business/about", label: "About", icon: Info },
  { prefix: "/settings/profile", label: "Profile", icon: UserRound },
  { prefix: "/settings/appearance", label: "Appearance", icon: Palette },
  { prefix: "/settings/auth", label: "Auth", icon: ShieldCheck },
  { prefix: "/settings/instructions", label: "Custom instructions", icon: Brain },
  { prefix: "/resources", label: "Resources", icon: Boxes },
  { prefix: "/agents", label: "Agents", icon: Bot },
  { prefix: "/skills", label: "Skills", icon: Puzzle },
  { prefix: "/routines", label: "Routines", icon: Workflow },
  { prefix: "/runs", label: "Runs", icon: Activity },
  { prefix: "/inbox", label: "Inbox", icon: Inbox },
  { prefix: "/knowledge", label: "Knowledge", icon: BookOpen },
  { prefix: "/integrations", label: "Integrations", icon: Plug },
  { prefix: "/operations", label: "Operations", icon: ShieldAlert },
  { prefix: "/settings", label: "Settings", icon: Settings },
  { prefix: "/design-guide", label: "Design guide", icon: Sparkles },
  { prefix: "/chats", label: "Chats", icon: MessageSquare },
  { prefix: "/chat", label: "Chat", icon: MessageSquare },
];

function pageForPath(pathname: string) {
  return (
    PAGE_META.find(({ prefix }) => pathname.startsWith(prefix)) ?? PAGE_META[PAGE_META.length - 1]
  );
}

export function titleForPath(pathname: string): string {
  return pageForPath(pathname)?.label ?? "Chat";
}

export function iconForPath(pathname: string): LucideIcon {
  return pageForPath(pathname)?.icon ?? MessageSquare;
}

const ALL_ITEMS: NavItem[] = Object.values(MODE_SECTIONS).flatMap((sections) =>
  sections.flatMap((section) => section.items)
);

export function sectionForPath(pathname: string): NavItem | undefined {
  return [...ALL_ITEMS]
    .sort((a, b) => b.to.length - a.to.length)
    .find((item) => pathname === item.to || pathname.startsWith(`${item.to}/`));
}
