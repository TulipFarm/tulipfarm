import { createHash } from 'node:crypto';
import { z } from 'zod';

export const qaAccounts = [
  { email: 'qa-admin@tulipfarm.site', name: 'QA Admin', role: 'admin', team: 'HR', teamRole: 'manager' },
  {
    email: 'qa-engineeringmember@tulipfarm.site',
    name: 'QA Engineering Member',
    role: 'member',
    team: 'Engineering',
    teamRole: 'member',
  },
  {
    email: 'qa-engineeringmanager@tulipfarm.site',
    name: 'QA Engineering Manager',
    role: 'member',
    team: 'Engineering',
    teamRole: 'manager',
  },
  { email: 'qa-hrmember@tulipfarm.site', name: 'QA HR Member', role: 'member', team: 'HR', teamRole: 'member' },
] as const;

export function isQaEmail(email: string) {
  return qaAccounts.some(account => account.email === email.trim().toLowerCase());
}

export const qaEmailSchema = z.string().trim().toLowerCase().refine(isQaEmail, 'Use an approved QA account email');
export const qaCredentialSchema = z.string().regex(/^tfqa_[A-Za-z0-9_-]{43}$/);
export const qaCredentialHash = (credential: string) =>
  createHash('sha256').update(qaCredentialSchema.parse(credential)).digest('hex');
