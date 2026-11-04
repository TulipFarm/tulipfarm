import { invitationTokenSchema } from '@tulipfarm/workspaces/governance-contracts';
import { z } from 'zod';

const storageKey = 'tulipfarm.pending-invitation';
const keepFor = 24 * 60 * 60 * 1000;
const pendingSchema = z.object({ token: invitationTokenSchema, until: z.number() });

/**
 * Remembers an opened invitation in this browser, so a sign-in that loses its redirect, such as a password reset,
 * still returns to the invitation instead of offering to create a workspace.
 */
export function rememberInvitation(token: string) {
  try {
    window.localStorage.setItem(storageKey, JSON.stringify({ token, until: Date.now() + keepFor }));
  } catch {
    /* The redirect in the sign-in links still carries the invitation. */
  }
}

export function forgetInvitation() {
  try {
    window.localStorage.removeItem(storageKey);
  } catch {
    /* Nothing was stored. */
  }
}

/** The invitation page to return to, or null when none was opened in the last day. */
export function pendingInvitationDestination() {
  try {
    const stored = window.localStorage.getItem(storageKey);
    if (!stored) return null;
    const pending = pendingSchema.safeParse(JSON.parse(stored));
    if (pending.success && pending.data.until > Date.now()) return `/invite?token=${pending.data.token}`;
  } catch {
    /* Unreadable storage holds no invitation. */
  }
  forgetInvitation();
  return null;
}
