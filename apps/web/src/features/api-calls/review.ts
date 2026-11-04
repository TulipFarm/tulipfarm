import { placementPhrase, placementSchema } from '@/features/secrets/contracts';
import type { ApiCallView } from './api';

type Secret = ApiCallView['secrets'][number];

export function target(call: ApiCallView) {
  try {
    const url = new URL(call.url);
    return `${url.host}${url.pathname === '/' ? '' : url.pathname}`;
  } catch {
    return call.host;
  }
}

export function secretPhrase(secret: Secret) {
  const placement = placementSchema.safeParse(secret.placement);
  return placement.success ? `${secret.name} ${placementPhrase(placement.data)}` : secret.name;
}

/** Headers a secret adds, with its name in place of the value. */
export function secretHeader(secret: Secret): [string, string] | null {
  const placement = placementSchema.safeParse(secret.placement);
  if (!placement.success) return null;
  const value = `‹${secret.name}›`;
  switch (placement.data.kind) {
    case 'bearer':
      return ['Authorization', `Bearer ${value}`];
    case 'basic':
      return ['Authorization', `Basic ${value}`];
    case 'header':
      return [placement.data.name ?? 'Header', value];
    case 'cookie':
      return ['Cookie', `${placement.data.name ?? 'cookie'}=${value}`];
    default:
      return null;
  }
}

const failures: Record<string, string> = {
  timeout: 'The service did not answer in time.',
  'network-failed': 'The connection failed.',
  'dns-failed': 'The address could not be found.',
  'address-denied': 'This address is not allowed.',
  'secret-unavailable': 'A secret could not be used.',
  disabled: 'Secrets are not available here.',
};

export function settled(call: ApiCallView): { title: string; detail?: string } | null {
  switch (call.status) {
    case 'awaiting-approval':
      return null;
    case 'sending':
      return { title: 'Sending…' };
    case 'sent':
      return { title: call.responseStatus === null ? 'Sent' : `Sent · ${call.responseStatus}` };
    case 'rejected':
      return { title: 'Not sent', detail: 'You chose not to send it.' };
    case 'expired':
      return { title: 'Expired', detail: 'Nobody approved it within 24 hours. Nothing was sent.' };
    case 'conflict':
      return { title: 'Not sent', detail: 'The request or a secret changed after it was proposed.' };
    case 'outcome-unknown':
      return { title: 'Outcome unknown', detail: 'The service may have received it. Check there before trying again.' };
    case 'failed':
      return {
        title: 'Failed',
        detail: (call.errorCode && failures[call.errorCode]) ?? 'It could not be sent.',
      };
  }
}
