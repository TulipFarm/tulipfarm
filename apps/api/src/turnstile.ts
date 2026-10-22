import { APIError } from 'better-auth/api';
import { observeFetch } from '@tulipfarm/observability';
import { z } from 'zod';

const verificationSchema = z.object({ success: z.literal(true), hostname: z.string(), action: z.string() });
const testVerificationSchema = z.object({
  success: z.literal(true),
  metadata: z.object({ result_with_testing_key: z.literal(true) }),
});
export const turnstileTestKeys = {
  siteKey: '1x00000000000000000000AA',
  secretKey: '1x0000000000000000000000000000000AA',
};
const testSiteKeys = [
  turnstileTestKeys.siteKey,
  '2x00000000000000000000AB',
  '1x00000000000000000000BB',
  '2x00000000000000000000BB',
  '3x00000000000000000000FF',
];
const testSecretKeys = [
  turnstileTestKeys.secretKey,
  '2x0000000000000000000000000000000AA',
  '3x0000000000000000000000000000000AA',
];

export function turnstileConfig() {
  const siteKey = process.env.TURNSTILE_SITE_KEY?.trim();
  const secretKey = process.env.TURNSTILE_SECRET_KEY?.trim();
  if (Boolean(siteKey) !== Boolean(secretKey)) {
    throw new Error('Set both TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY');
  }
  const local = !process.env.NODE_ENV || ['development', 'test'].includes(process.env.NODE_ENV);
  if (!local && ((siteKey && testSiteKeys.includes(siteKey)) || (secretKey && testSecretKeys.includes(secretKey)))) {
    throw new Error('Turnstile test keys are only allowed in development and test');
  }
  if (local && !siteKey && !secretKey) return { ...turnstileTestKeys };
  return siteKey && secretKey ? { siteKey, secretKey } : null;
}

// A null config means Turnstile is not configured: challenges are skipped.
export function createTurnstileVerifier(
  config: ReturnType<typeof turnstileConfig>,
  webOrigin: string,
  action: 'sign_in' | 'create_workspace' | 'public_guide' = 'sign_in',
) {
  const hostname = new URL(webOrigin).hostname;
  const testKeys =
    (!process.env.NODE_ENV || ['development', 'test'].includes(process.env.NODE_ENV)) &&
    config !== null &&
    testSiteKeys.includes(config.siteKey) &&
    testSecretKeys.includes(config.secretKey);
  return async (token: string | null) => {
    if (!config) return;
    let valid = false;
    if (token?.trim() && token.length <= 2048) {
      try {
        const response = await observeFetch('turnstile', 'verify')(
          'https://challenges.cloudflare.com/turnstile/v0/siteverify',
          {
            method: 'POST',
            body: new URLSearchParams({ secret: config.secretKey, response: token }),
            signal: AbortSignal.timeout(5000),
            redirect: 'error',
          },
        );
        if (response.ok) {
          const body: unknown = await response.json();
          if (testKeys) {
            valid = token === 'XXXX.DUMMY.TOKEN.XXXX' && testVerificationSchema.safeParse(body).success;
          } else {
            const result = verificationSchema.safeParse(body);
            valid = result.success && result.data.hostname === hostname && result.data.action === action;
          }
        }
      } catch {
        valid = false;
      }
    }
    if (!valid)
      throw new APIError('FORBIDDEN', {
        code: 'CHALLENGE_FAILED',
        message: 'Verification failed. Please complete a new challenge.',
      });
  };
}
