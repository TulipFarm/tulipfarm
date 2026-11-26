import {
  onboardingDraftSchema,
  workspaceUrlAvailabilitySchema,
  type OnboardingDetails,
} from '@tulipfarm/workspaces/onboarding-contracts';
import { workspaceSchema } from '@tulipfarm/workspaces/contracts';
import { apiOrigin } from './auth';
import { jsonResponse, readJson, responseError } from './http';
import { WorkspaceRequestError } from './workspaces';

export function newOnboardingToken() {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, '0')).join('');
}

async function request(path: string, body: unknown) {
  const response = await jsonResponse(`${apiOrigin}/v1/onboarding/${path}`, {
    method: 'POST',
    body,
    signal: AbortSignal.timeout(15_000),
  });
  const data = await readJson(response);
  if (!response.ok)
    throw new WorkspaceRequestError(
      response.status,
      responseError(data, 'Could not save your onboarding details. Please try again.'),
    );
  return data;
}
export async function saveOnboarding(token: string, details: OnboardingDetails) {
  return onboardingDraftSchema.parse(await request('drafts', { token, details }));
}
export async function workspaceUrlAvailable(slug: string) {
  return workspaceUrlAvailabilitySchema.parse(await request('availability', { slug })).available;
}
export async function resumeOnboarding(token: string) {
  return onboardingDraftSchema.parse(await request('resume', { token }));
}
export async function completeOnboarding(token: string, challengeToken: string) {
  return workspaceSchema.parse(await request('complete', { token, ...(challengeToken ? { challengeToken } : {}) }));
}

// After sign-up, Bud continues the onboarding chat in the new workspace. The flag lives for this tab only, and the API
// continues the chat at most once, so reopening the workspace later never repeats it.
const continueKey = 'tulipfarm:continue-onboarding';
export function markOnboardingToContinue(workspaceId: string) {
  try {
    sessionStorage.setItem(continueKey, workspaceId);
  } catch {}
}
export function takeOnboardingToContinue(workspaceId: string) {
  try {
    if (sessionStorage.getItem(continueKey) !== workspaceId) return false;
    sessionStorage.removeItem(continueKey);
    return true;
  } catch {
    return false;
  }
}
