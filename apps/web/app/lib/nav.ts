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

export type NavItem = {
  to: string;
  label: string;
  icon: LucideIcon;
  badge?: boolean;
  devOnly?: boolean;
  /** Reachable regardless of `visiblePaths`. Chat is the product's floor, never a grant. */ always?: boolean;
  /**
   * The one line the top bar cannot say. Rendered by the section shell instead of a second page
   * title, so a page is named once.
   */
  description?: string;
};

export type NavGroup = {
  heading: string;
  items: NavItem[];
};

export type NavigationVisibility = {
  isDev: boolean;
  visiblePaths?: readonly string[];
};

/**
 * The whole sidebar, in render order. One flat list under three headings, so what a reader can
 * reach is what they can see — there is no second navigation layer to open.
 *
 * The split is by verb, not by subject: this list is what you *do and watch*. Anything you
 * *configure* lives in `SETTINGS_GROUPS`, because a sidebar carrying every configuration page
 * stops being scannable at exactly the size this product reaches.
 */
export const SIDEBAR_GROUPS: NavGroup[] = [
  {
    heading: "Work",
    items: [
      { to: "/chats", label: "Chats", icon: MessageSquare, always: true },
      { to: "/inbox", label: "Inbox", icon: Inbox, badge: true },
      {
        to: "/business/activities",
        label: "Activity",
        icon: History,
        description:
          "One timeline of everything that happened here: Runs, Records, Chats, and Jobs.",
      },
      { to: "/farm", label: "Farm", icon: Flower2 },
    ],
  },
  {
    heading: "Build",
    items: [
      { to: "/resources", label: "Resources", icon: Boxes },
      { to: "/agents", label: "Agents", icon: Bot },
      { to: "/skills", label: "Skills", icon: Puzzle },
      { to: "/routines", label: "Routines", icon: Workflow },
      { to: "/knowledge", label: "Knowledge", icon: BookOpen },
    ],
  },
];

/**
 * Pinned below the scrolling list rather than ending it, so the door to every configuration page
 * sits at a fixed spot next to the account it belongs beside, instead of drifting with the list.
 */
export const SETTINGS_ITEM: NavItem = { to: "/settings", label: "Settings", icon: Settings };

/**
 * Everything reached through Settings. Configuration surfaces are visited rarely and
 * deliberately, so they sit one click below the work they configure instead of competing with it
 * for sidebar space.
 */
export const SETTINGS_GROUPS: NavGroup[] = [
  {
    heading: "You",
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
          "Which models answer a chat turn and index Knowledge, and what each one costs.",
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
        to: "/business/guardrails",
        label: "Guardrails",
        icon: ShieldCheck,
        description: "Limits every agent is checked against, before and after it acts.",
      },
      {
        to: "/business/soul",
        label: "Soul",
        icon: Sparkles,
        description: "Browse the version-controlled repository your workspace is defined in.",
      },
      {
        to: "/business/access",
        label: "People & access",
        icon: Users,
        description:
          "Invite people, turn accounts off, and decide what each person is allowed to do.",
      },
      {
        to: "/business/about",
        label: "About",
        icon: Info,
        description: "Which version this instance runs, and whether a newer one exists.",
      },
    ],
  },
  {
    heading: "Operate",
    items: [
      {
        to: "/operations",
        label: "Operations",
        icon: ShieldAlert,
        description:
          "Instance health, open incidents, and the kill switches that stop every agent.",
      },
      {
        to: "/business/observability",
        label: "Observability",
        icon: Gauge,
        description: "What your agents are spending and doing: cost, tokens, and reliability.",
      },
    ],
  },
  {
    heading: "Developer",
    items: [{ to: "/design-guide", label: "Design guide", icon: Sparkles, devOnly: true }],
  },
];

function isVisible(item: NavItem, { isDev, visiblePaths }: NavigationVisibility): boolean {
  if (item.devOnly && !isDev) return false;
  if (item.always) return true;
  return visiblePaths === undefined || visiblePaths.includes(item.to);
}

function filterGroups(groups: NavGroup[], visibility: NavigationVisibility): NavGroup[] {
  return groups
    .map((group) => ({
      ...group,
      items: group.items.filter((item) => isVisible(item, visibility)),
    }))
    .filter((group) => group.items.length > 0);
}

export function visibleSettingsGroups(visibility: NavigationVisibility): NavGroup[] {
  return filterGroups(SETTINGS_GROUPS, visibility);
}

export function visibleSidebarGroups(visibility: NavigationVisibility): NavGroup[] {
  return filterGroups(SIDEBAR_GROUPS, visibility);
}

/**
 * Settings is a door, not a page, so it is offered only when something behind it is reachable.
 */
export function visibleSettingsItem(visibility: NavigationVisibility): NavItem | undefined {
  return visibleSettingsGroups(visibility).length > 0 ? SETTINGS_ITEM : undefined;
}

const PAGE_META: Array<{ prefix: string; label: string; icon: LucideIcon }> = [
  { prefix: "/farm", label: "Farm", icon: Flower2 },
  { prefix: "/business/activities", label: "Activity", icon: History },
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

const ALL_ITEMS: NavItem[] = [
  SETTINGS_ITEM,
  ...[...SIDEBAR_GROUPS, ...SETTINGS_GROUPS].flatMap((group) => group.items),
];

/**
 * The nav item a path belongs to.
 */
export function sectionForPath(pathname: string): NavItem | undefined {
  return [...ALL_ITEMS]
    .sort((a, b) => b.to.length - a.to.length)
    .find((item) => pathname === item.to || pathname.startsWith(`${item.to}/`));
}
