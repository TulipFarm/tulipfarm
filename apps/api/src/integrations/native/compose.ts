import type { SecretsService } from "@tulipfarm/secrets";
import { getAgent, getDefaultAssistant, type SoulLoader } from "@tulipfarm/soul";
import {
  ChannelInboundStore,
  ChannelMentionedThreadStore,
  NativeChannelInboxStore,
  type TransactionPort,
} from "@tulipfarm/storage";
import { mayUseAgent } from "../../chat/agent-access";
import type { TeamAssetService } from "../../team-assets/service";
import { NativeChannelCredentials } from "./credentials";
import { type NativeChannelDeps, NativeChannelService } from "./service";

export function composeNativeChannels(
  deps: Omit<
    NativeChannelDeps,
    "credentials" | "inbox" | "inbound" | "mentionedThreads" | "mayUseAgent"
  > & {
    readonly transactions: TransactionPort;
    readonly secrets: SecretsService;
    readonly soulLoader: SoulLoader;
    readonly teamAssets: TeamAssetService;
    readonly publicApiUrl: () => string;
  }
) {
  const service = new NativeChannelService({
    ...deps,
    credentials: new NativeChannelCredentials(deps.secrets, deps.soulLoader),
    inbox: new NativeChannelInboxStore(deps.transactions),
    inbound: new ChannelInboundStore(deps.transactions),
    mentionedThreads: new ChannelMentionedThreadStore(deps.transactions, () =>
      new Date().toISOString()
    ),
    mayUseAgent: async (agentId, userId) => {
      const agent = getAgent(deps.soulLoader, agentId) ?? getDefaultAssistant(agentId);
      return agent ? mayUseAgent(agent, { kind: "user", id: userId }, deps.teamAssets) : false;
    },
  });
  return {
    service,
    routes: { service, publicApiUrl: deps.publicApiUrl },
  };
}
