import { z } from 'zod';
import { AccessDenied } from '@tulipfarm/access';

const providerCodes = new Set([
  'access_denied',
  'accesslimited',
  'account_inactive',
  'app_not_admin_approved',
  'app_not_org_installed',
  'bad_client_secret',
  'bad_redirect_uri',
  'invalid_client_id',
  'invalid_code',
  'invalid_grant_type',
  'invalid_auth',
  'invalid_arguments',
  'invalid_form_data',
  'invalid_post_type',
  'missing_post_type',
  'invalid_code_verifier',
  'invalid_scope',
  'missing_scope',
  'not_allowed_token_type',
  'ratelimited',
  'internal_error',
  'fatal_error',
  'token_revoked',
  'team_access_not_granted',
]);
export function slackOAuthErrorCode(value: unknown) {
  return typeof value === 'string' && providerCodes.has(value) ? value : 'unrecognized-provider-error';
}

export class SlackTokenExchangeError extends Error {
  readonly providerCode: string;
  constructor(providerCode: unknown) {
    super('slack-token-exchange-failed');
    this.providerCode = slackOAuthErrorCode(providerCode);
  }
}

const knownMessages = new Set([
  'slack-linking-disabled',
  'slack-provider-unavailable',
  'slack-provider-response-limit',
  'slack-identity-mismatch',
  'slack-nonce-mismatch',
  'slack-token-unsupported',
  'slack-scope-missing',
]);
const knownCodes = new Set([
  'ERR_JWT_EXPIRED',
  'ERR_JWT_CLAIM_VALIDATION_FAILED',
  'ERR_JWS_SIGNATURE_VERIFICATION_FAILED',
  'ERR_JWKS_NO_MATCHING_KEY',
  'ERR_JWKS_TIMEOUT',
  'ERR_JWS_INVALID',
  'ERR_JWT_INVALID',
  '42501',
  '23505',
  '23503',
  '42P01',
  '42703',
  'incompatible_version',
  'unavailable',
]);
const fields = new Set([
  'ok',
  'access_token',
  'token_type',
  'id_token',
  'authed_user',
  'id',
  'scope',
  'team',
  'refresh_token',
  'expires_in',
  'is_enterprise_install',
  'sub',
  'nonce',
  'https://slack.com/team_id',
  'https://slack.com/user_id',
  'credential',
  'rotation',
  'state',
]);

export function slackLinkFailure(error: unknown) {
  if (error instanceof AccessDenied) return { 'error.type': 'access-denied' };
  if (error instanceof SlackTokenExchangeError)
    return { 'error.type': 'slack-token-exchange-failed', 'error.issues': slackOAuthErrorCode(error.providerCode) };
  if (error instanceof z.ZodError)
    return {
      'error.type': 'invalid-slack-data',
      'error.issues': JSON.stringify(
        error.issues.slice(0, 12).map(issue => ({
          code: issue.code,
          path: issue.path.map(field => (typeof field === 'string' && fields.has(field) ? field : '_')),
        })),
      ),
    };
  if (error instanceof Error) {
    if (knownMessages.has(error.message)) return { 'error.type': error.message };
    if ('code' in error && typeof error.code === 'string' && knownCodes.has(error.code))
      return { 'error.type': error.code };
    if (
      ['AccessDenied', 'StorageUnavailableError', 'TimeoutError', 'AbortError', 'SyntaxError', 'TypeError'].includes(
        error.name,
      )
    )
      return { 'error.type': error.name };
  }
  return { 'error.type': 'unclassified-slack-link-failure' };
}
