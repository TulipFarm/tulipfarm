import type { BadgeVariant } from '@tulipfarm/sprout/badge';
import type { AppDetail, AppDraftState, AppSummary } from './api';
import { unitsPerCredit } from './api';

type Tone = BadgeVariant;

export const kindLabels = { public: 'Public', private: 'Private' } as const;

/** Why a public app is or is not serving, with the stop that wins named first. */
export function servingStatus(app: AppSummary): { label: string; tone: Tone } | null {
  if (app.kind === 'private') return null;
  if (app.stops.disabledAt) return { label: 'Turned off by an admin', tone: 'destructive' };
  if (app.stops.budgetPausedAt) return { label: 'Paused: out of credits', tone: 'warning' };
  if (app.stops.editorPausedAt) return { label: 'Paused', tone: 'warning' };
  if (!app.liveReleaseId) return { label: 'Not published', tone: 'secondary' };
  return { label: 'Live', tone: 'success' };
}

export const draftLabels: Record<AppDraftState, string> = {
  empty: 'Empty',
  editing: 'Being edited',
  building: 'Building',
  // oxlint-disable-next-line tulipfarm/product-copy -- A draft state identifier, not user-facing copy.
  'preview-ready': 'Ready to try',
  failed: 'Build failed',
  saved: 'Saved',
};

export function approvalLabel(approval: AppSummary['approval']): { label: string; tone: Tone } {
  switch (approval.state) {
    case 'not-requested':
      return { label: 'Not requested', tone: 'secondary' };
    case 'requested':
      return { label: 'Waiting for an admin', tone: 'info' };
    case 'approved':
      return { label: 'Approved', tone: 'success' };
    case 'rejected':
      return { label: 'Rejected', tone: 'destructive' };
  }
}

export const roleLabels = { use: 'Can use', edit: 'Can edit' } as const;

export function creditsLabel(units: string) {
  const value = BigInt(units);
  const whole = value / unitsPerCredit;
  return `${whole.toLocaleString()} ${whole === 1n ? 'credit' : 'credits'} a month`;
}

/** Whole credits as typed, or null when the text is not a whole number. */
export function creditsToUnits(text: string) {
  const trimmed = text.trim().replaceAll(',', '');
  if (!/^\d{1,12}$/.test(trimmed)) return null;
  return (BigInt(trimmed) * unitsPerCredit).toString();
}

const dateFormat = new Intl.DateTimeFormat([], { month: 'short', day: 'numeric', year: 'numeric' });
export const formatDay = (iso: string) => dateFormat.format(new Date(iso));

export const shortCommit = (commit: string) => commit.slice(0, 7);

export const canEdit = (app: AppSummary | AppDetail) => app.role === 'edit';
