import type { ConversationMode } from "@tulipfarm/schema";
import type { ComponentType } from "react";
import type { IconProps } from "reicon-react/createIcon";
import { BookOpen, Bulb, Search, Waypoints } from "~/components/icons";

export interface ModeConfig {
  readonly id: ConversationMode;
  readonly label: string;
  readonly description: string;
  readonly icon: ComponentType<IconProps>;
  readonly colorVar: string;
}

export const MODE_CONFIGS: Record<ConversationMode, ModeConfig> = {
  plan: {
    id: "plan",
    label: "Plan",
    description: "Structured task breakdown and execution",
    icon: Waypoints,
    colorVar: "var(--mode-plan)",
  },
  brainstorm: {
    id: "brainstorm",
    label: "Brainstorm",
    description: "Collaborative alignment and decision-making",
    icon: Bulb,
    colorVar: "var(--mode-brainstorm)",
  },
  research: {
    id: "research",
    label: "Research",
    description: "Deep investigation with cited sources",
    icon: Search,
    colorVar: "var(--mode-research)",
  },
  learn: {
    id: "learn",
    label: "Learn",
    description: "Interactive guided learning",
    icon: BookOpen,
    colorVar: "var(--mode-learn)",
  },
};

export const CONVERSATION_MODES_LIST: readonly ModeConfig[] = [
  MODE_CONFIGS.plan,
  MODE_CONFIGS.brainstorm,
  MODE_CONFIGS.research,
  MODE_CONFIGS.learn,
];
