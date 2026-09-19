export interface ProviderGuide {
  description: string;
  capabilities: readonly string[];
  instructions: readonly string[];
  credentialLink?: { label: string; url: string };
}

const GUIDES: Record<string, ProviderGuide> = {
  github: {
    description: "Work with your repositories, issues and pull requests.",
    capabilities: ["Repositories & files", "Issues & pull requests", "Code review"],
    instructions: [
      "Create a personal access token in GitHub.",
      "Choose only the repositories and permissions you want agents to use. Your organization may need to approve the token.",
      "Paste the token into the secure field below, then connect your account.",
    ],
    credentialLink: {
      label: "Create a GitHub token",
      url: "https://github.com/settings/personal-access-tokens/new",
    },
  },
  slack: {
    description: "Bring conversations and workspace context into your agents’ work.",
    capabilities: ["Messages", "Channels & threads", "Workspace context"],
    instructions: [
      "Ask your Slack admin to register an eligible app and provide its sign-in details.",
      "Continue below and sign in with your own Slack account. A bot token cannot be used instead.",
      "Return here after sign-in to finish the setup you already approved.",
    ],
  },
  "google-drive": {
    description: "Find and work with files your Google account can access.",
    capabilities: ["Files & documents", "File search", "Shared content"],
    instructions: [
      "Ask your admin to enable the required Google services and register an app for sign-in.",
      "Continue below, enter the app details when asked, and sign in with Google.",
      "Check which Google files and permissions you are granting.",
    ],
  },
  notion: {
    description: "Use pages, databases and knowledge from your workspace.",
    capabilities: ["Pages", "Databases", "Workspace search"],
    instructions: [
      "Continue below and sign in to Notion.",
      "Choose the workspace and access you want to share.",
      "Finish your saved setup after signing in. Some features depend on your Notion plan.",
    ],
  },
  linear: {
    description: "Keep up with issues, projects and your team’s work.",
    capabilities: ["Issues", "Projects", "Team planning"],
    instructions: [
      "Use a Linear API key, or choose browser sign-in.",
      "Connect a separate account for each workspace.",
      "Connect handles setup. You can narrow access later in Advanced settings.",
    ],
    credentialLink: { label: "Open Linear API settings", url: "https://linear.app/settings/api" },
  },
};

export function providerGuide(id: string): ProviderGuide | undefined {
  return GUIDES[id];
}
