import { apiWrite } from "./api";

export type ChannelBindOffer = {
  slug: string;
  senderId: string;
  expiresAt: string;
  account: { userId: string; email: string };
};

export type ChannelLink = {
  provider: string;
  externalSubject: string;
  userId: string;
  verifiedAt: string;
};

/**
 * The token travels in the body rather than the query string: a query string reaches access
 * logs and `Referer` headers, and this one is a credential until it is spent.
 */
export function previewChannelBind(token: string): Promise<ChannelBindOffer> {
  return apiWrite<ChannelBindOffer>("POST", "/api/v1/identity/channel-links/preview", { token });
}

export function confirmChannelBind(token: string): Promise<{ link: ChannelLink }> {
  return apiWrite<{ link: ChannelLink }>("POST", "/api/v1/identity/channel-links/confirm", {
    token,
  });
}
