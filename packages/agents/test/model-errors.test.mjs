import assert from 'node:assert/strict';
import { test } from 'node:test';
import { modelHttpError } from '../dist/inference.js';

const response = (status, headers = {}) => ({ status, headers: new Headers(headers) });
const azure = (code, message) => ({ error: { code, message } });

// [case, provider, status, body, headers, stored reason, class]
const cases = [
  [
    'Azure deployment not found',
    'azure',
    404,
    azure('DeploymentNotFound', 'The API deployment for this resource does not exist.'),
    {},
    'configuration',
    'not_found',
  ],
  [
    'OpenAI model not found',
    'openai',
    404,
    azure('model_not_found', 'The model does not exist.'),
    {},
    'configuration',
    'not_found',
  ],
  [
    'Anthropic not found',
    'anthropic',
    404,
    { type: 'error', error: { type: 'not_found_error', message: 'model: x' } },
    {},
    'configuration',
    'not_found',
  ],
  [
    '401 invalid key',
    'azure',
    401,
    azure('401', 'Access denied due to invalid subscription key.'),
    {},
    'authentication',
    'auth',
  ],
  [
    'OpenAI invalid_api_key',
    'openai',
    400,
    azure('invalid_api_key', 'Incorrect API key provided.'),
    {},
    'authentication',
    'auth',
  ],
  [
    '403 permission',
    'azure',
    403,
    azure('PermissionDenied', 'Principal does not have access.'),
    {},
    'permission',
    'auth',
  ],
  [
    'Azure 429 rate limit',
    'azure',
    429,
    azure('429', 'Requests to the deployment have exceeded the rate limit.'),
    { 'retry-after': '5' },
    'rate-limit',
    'rate_limited',
  ],
  [
    'OpenAI 429 rate limit',
    'openai',
    429,
    azure('rate_limit_exceeded', 'Rate limit reached.'),
    {},
    'rate-limit',
    'rate_limited',
  ],
  [
    '429 quota',
    'azure',
    429,
    azure('insufficient_quota', 'You exceeded your current quota.'),
    {},
    'quota',
    'quota_exceeded',
  ],
  [
    'Anthropic credit balance',
    'anthropic',
    400,
    { type: 'error', error: { type: 'invalid_request_error', message: 'Your credit balance is too low.' } },
    {},
    'quota',
    'quota_exceeded',
  ],
  [
    'Azure content filter',
    'azure',
    400,
    azure(
      'content_filter',
      "The response was filtered due to the prompt triggering Azure OpenAI's content management policy.",
    ),
    {},
    'refusal',
    'content_filtered',
  ],
  [
    'context length',
    'azure',
    400,
    azure('context_length_exceeded', "This model's maximum context length is 8192 tokens."),
    {},
    'context-overflow',
    'context_too_long',
  ],
  [
    'Anthropic prompt too long',
    'anthropic',
    400,
    { type: 'error', error: { type: 'invalid_request_error', message: 'prompt is too long: 210000 tokens' } },
    {},
    'context-overflow',
    'context_too_long',
  ],
  [
    'unsupported parameter',
    'azure',
    400,
    azure('unsupported_parameter', "Unsupported parameter: 'max_tokens'."),
    {},
    'invalid-request',
    'bad_request',
  ],
  ['API version', 'azure', 404, azure('404', 'Resource not found'), {}, 'configuration', 'not_found'],
  [
    'overloaded',
    'anthropic',
    529,
    { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } },
    {},
    'overload',
    'server_error',
  ],
  [
    '503',
    'azure',
    503,
    azure('ServiceUnavailable', 'The service is temporarily unavailable.'),
    {},
    'unavailable',
    'server_error',
  ],
  ['500 without body', 'openai-compatible', 500, null, {}, 'unavailable', 'server_error'],
  ['unexpected status', 'azure', 418, null, {}, 'provider-error', 'unknown'],
];

test('provider HTTP failures map to a bounded class and keep the stored model-<reason> code', () => {
  for (const [name, provider, status, body, headers, reason, errorClass] of cases) {
    const error = modelHttpError(response(status, headers), body, provider);
    assert.equal(error.message, `model-${reason}`, name);
    assert.equal(error.code, errorClass, name);
    assert.equal(error.modelDiagnostics.status, status, name);
    assert.equal(error.modelDiagnostics.outputStarted, false, name);
  }
});

test('provider details are kept for logs only when safe, and prompt echoes are removed', () => {
  const request = JSON.stringify({ messages: [{ role: 'user', content: 'PRIVATE launch plan for the board' }] });
  const error = modelHttpError(
    response(400),
    azure(
      'invalid_value',
      "Invalid 'messages[0].content': PRIVATE launch plan for the board. Bearer sk-secret-1234567890",
    ),
    'azure',
    true,
    request,
  );
  assert.equal(error.code, 'bad_request');
  assert.equal(error.modelDiagnostics.providerCode, 'invalid_value');
  assert.equal(error.modelDiagnostics.outputStarted, true);
  assert.ok(!error.modelDiagnostics.providerMessage.includes('PRIVATE'), error.modelDiagnostics.providerMessage);
  assert.ok(!error.modelDiagnostics.providerMessage.includes('sk-secret'), error.modelDiagnostics.providerMessage);
  const unsafe = modelHttpError(response(400), azure('code with spaces PRIVATE', 'x'), 'azure');
  assert.equal(unsafe.modelDiagnostics.providerCode, undefined);
});
