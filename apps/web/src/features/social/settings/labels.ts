import type {
  AccessTier,
  AccountState,
  AppSource,
  Capability,
  Channel,
  ChannelKind,
  PlatformAvailability,
  SocialAccountMetadata,
} from '@tulipfarm/social/contracts';
import { SocialRequestError, socialError } from '@/lib/social';
import { platformNames } from '../presentation';

export type Principal = { id: string; name: string };
export type PrincipalSet = { memberIds: string[]; teamIds: string[] };

export const accountStates: Record<
  AccountState,
  { label: string; tone: 'success' | 'warning' | 'destructive' | 'secondary' }
> = {
  authorizing: { label: 'Waiting for sign-in', tone: 'secondary' },
  active: { label: 'Connected', tone: 'success' },
  // A routine token refresh keeps the connection usable (PRODUCT 8).
  refreshing: { label: 'Connected', tone: 'success' },
  'reconnect-required': { label: 'Reconnect required', tone: 'warning' },
  disabled: { label: 'Disabled', tone: 'secondary' },
  disconnected: { label: 'Disconnected', tone: 'secondary' },
};

export const appSources: Record<AppSource, string> = {
  hosted: 'TulipFarm app',
  operator: 'Server app',
  workspace: 'Workspace app',
};

export const accessTiers: Record<AccessTier, string> = {
  share: 'Share',
  'community-management': 'Community management',
  unverified: 'Unverified',
  verified: 'Verified',
  standard: 'Standard',
  advanced: 'Advanced',
  trial: 'Trial',
  unaudited: 'Unaudited',
  audited: 'Audited',
  paid: 'Paid',
};

export const capabilities: Record<Capability, string> = {
  publish: 'private posts',
  'publish-public': 'public posts',
  analytics: 'analytics',
  comments: 'comments',
  messages: 'messages',
};

export const channelKinds: Record<ChannelKind, string> = {
  'member-profile': 'Profile',
  'organization-page': 'Company page',
  'youtube-channel': 'Channel',
  'facebook-page': 'Page',
  'instagram-business': 'Business account',
  'instagram-creator': 'Creator account',
  'threads-profile': 'Profile',
  'pinterest-account': 'Account',
  'tiktok-account': 'Account',
  'x-account': 'Account',
  'reddit-user': 'User',
};

export function offered(availability: PlatformAvailability) {
  const names = availability.capabilities.map(item => capabilities[item]);
  return names.length ? `Allows ${names.join(', ')}.` : '';
}

export function accountName(account: SocialAccountMetadata) {
  return account.identity?.displayName || account.identity?.handle || `${platformNames[account.platform]} account`;
}

/** A channel added before the connection's last reconnect must be added again (PRODUCT 8). */
export function channelStale(channel: Channel, account: SocialAccountMetadata) {
  return channel.accountGeneration !== account.generation;
}

export function holds(set: PrincipalSet, membershipId: string, teamIds: readonly string[]) {
  return set.memberIds.includes(membershipId) || set.teamIds.some(team => teamIds.includes(team));
}

/** Only a platform's own sign-in page is followed; a malformed URL is never navigated to. */
export function signInUrl(value: string) {
  const url = new URL(value);
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.username || url.password || (url.protocol !== 'https:' && !(local && url.protocol === 'http:')))
    throw new Error('Invalid sign-in URL');
  return url.href;
}

const settingsMessages: Record<string, string> = {
  'account-conflict': 'This connection changed. Refresh and try again.',
  'channel-conflict': 'This channel changed. Refresh and try again.',
  'grants-invalid':
    'These grants were refused. Keep at least one manager who is still a member. Personal connections can only be granted to their owner.',
};

export function settingsError(error: unknown) {
  if (error instanceof SocialRequestError) {
    const known = settingsMessages[error.code];
    if (known) return known;
    if (error.status === 403 || error.status === 404)
      return 'You no longer have access to this. Refresh the page to see what you can manage.';
  }
  return socialError(error);
}
