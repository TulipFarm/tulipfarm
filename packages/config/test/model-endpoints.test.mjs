import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  modelEndpointHosts,
  modelEndpointProblem,
  modelEndpointShapeProblem,
  normalizeModelEndpoint,
} from '../src/model-endpoints.ts';
import { modelPricingEntrySchema } from '../src/model-continuity.ts';

const dev = { NODE_ENV: 'development', MODEL_ENDPOINT_HOSTS: 'localhost,127.0.0.1,::1,gateway.example.com' };

test('http is allowed only for allowlisted loopback hosts outside production', () => {
  for (const endpoint of ['http://localhost:11434/v1/', 'http://127.0.0.1:8000/', 'http://[::1]:8000/v1/'])
    assert.equal(modelEndpointProblem('openai-compatible', endpoint, dev), null, endpoint);
  assert.equal(
    modelEndpointProblem('openai-compatible', 'http://localhost:11434/v1/', { ...dev, NODE_ENV: 'production' }),
    'must use https in production',
  );
  assert.equal(
    modelEndpointProblem('openai', 'http://gateway.example.com/v1/', dev),
    'must use https (http is allowed only for localhost)',
  );
  assert.equal(
    modelEndpointProblem('openai-compatible', 'http://localhost:11434/v1/', { NODE_ENV: 'development' }),
    'host localhost is not in MODEL_ENDPOINT_HOSTS',
  );
});

test('a host outside MODEL_ENDPOINT_HOSTS never receives a credential', () => {
  assert.equal(
    modelEndpointProblem('openai', 'https://evil.example.com/v1/', dev),
    'host evil.example.com is not in MODEL_ENDPOINT_HOSTS',
  );
  assert.equal(
    modelEndpointProblem('anthropic', 'https://gateway.example.com.evil.test/', dev),
    'host gateway.example.com.evil.test is not in MODEL_ENDPOINT_HOSTS',
  );
  assert.equal(modelEndpointProblem('anthropic', 'https://gateway.example.com:8443/anthropic/', dev), null);
  assert.match(modelEndpointProblem('openai', 'https://gateway.example.com/', {}), /not in MODEL_ENDPOINT_HOSTS/);
});

test('built-in provider and Azure resource hosts are allowed without an allowlist entry', () => {
  for (const [provider, endpoint] of [
    ['anthropic', 'https://api.anthropic.com/'],
    ['openai', 'https://api.openai.com/'],
    ['openai', 'https://api.openai.com/v1/'],
    ['xai', 'https://api.x.ai/'],
    ['google', 'https://generativelanguage.googleapis.com/'],
    ['azure', 'https://acme.openai.azure.com/'],
    ['azure', 'https://acme.services.ai.azure.com/'],
  ])
    assert.equal(modelEndpointProblem(provider, endpoint, { NODE_ENV: 'production' }), null, endpoint);
  // A built-in host is only implicit for its own provider, and never for openai-compatible.
  assert.match(modelEndpointProblem('anthropic', 'https://api.openai.com/', {}), /not in MODEL_ENDPOINT_HOSTS/);
  assert.match(
    modelEndpointProblem('openai-compatible', 'https://api.openai.com/v1/', {}),
    /not in MODEL_ENDPOINT_HOSTS/,
  );
  assert.match(modelEndpointProblem('azure', 'https://acme.openai.azure.com:444/', {}), /not in MODEL_ENDPOINT_HOSTS/);
});

test('URLs with credentials, a query or a fragment are rejected', () => {
  for (const endpoint of [
    'https://user:pass@gateway.example.com/',
    'https://user@gateway.example.com/',
    'https://:secret@api.openai.com/',
  ]) {
    assert.equal(modelEndpointShapeProblem(endpoint), 'must not contain credentials', endpoint);
    assert.equal(modelEndpointProblem('openai', endpoint, dev), 'must not contain credentials', endpoint);
  }
  for (const endpoint of [
    'https://gateway.example.com/?key=1',
    'https://gateway.example.com/#x',
    'https://a.example/?',
  ])
    assert.equal(modelEndpointShapeProblem(endpoint), 'must not have a query or fragment', endpoint);
  assert.equal(modelEndpointShapeProblem('ftp://gateway.example.com/'), 'must use https');
  assert.equal(modelEndpointShapeProblem('gateway.example.com'), 'is not a URL');
  assert.equal(
    modelEndpointProblem('openai', 'https://gateway.example.com/v1', dev),
    'must be normalized with a trailing slash',
  );
});

test('endpoints normalize to origin plus a slash-terminated path', () => {
  assert.equal(normalizeModelEndpoint('https://Gateway.Example.com'), 'https://gateway.example.com/');
  assert.equal(normalizeModelEndpoint('https://gateway.example.com:443/openai'), 'https://gateway.example.com/openai/');
  assert.equal(normalizeModelEndpoint('http://localhost:11434/v1/'), 'http://localhost:11434/v1/');
});

test('MODEL_ENDPOINT_HOSTS takes bare host names', () => {
  assert.deepEqual(
    [...modelEndpointHosts({ MODEL_ENDPOINT_HOSTS: ' A.example.com, [::1] ,,b.example' })],
    ['a.example.com', '::1', 'b.example'],
  );
  assert.equal(modelEndpointHosts({}).size, 0);
  for (const value of ['https://a.example.com', 'a.example.com:443', 'a.example.com/v1', '*.example.com'])
    assert.throws(
      () => modelEndpointHosts({ MODEL_ENDPOINT_HOSTS: value }),
      /MODEL_ENDPOINT_HOSTS: .* is not a host name/,
    );
});

test('catalog models declare endpoint and credentialEnv exactly for openai-compatible', () => {
  const model = {
    id: 'llama-local',
    name: 'Llama',
    provider: 'openai-compatible',
    providerModelId: 'llama3.3',
    endpoint: 'http://localhost:11434/v1',
    credentialEnv: 'OLLAMA_API_KEY',
    metadata: { max_input_tokens: 128000, max_output_tokens: 4096 },
  };
  assert.equal(modelPricingEntrySchema.parse(model).endpoint, 'http://localhost:11434/v1');
  const fails = (value, pattern) => {
    const result = modelPricingEntrySchema.safeParse(value);
    assert.equal(result.success, false, JSON.stringify(value));
    assert.match(JSON.stringify(result.error.issues), pattern);
  };
  const { endpoint, credentialEnv, ...bare } = model;
  fails({ ...model, endpoint: undefined }, /endpoint/);
  fails({ ...model, credentialEnv: undefined }, /credentialEnv/);
  fails({ ...model, endpoint: 'https://u:p@gateway.example.com/' }, /must not contain credentials/);
  fails({ ...model, endpoint: 'https://gateway.example.com/?k=1' }, /query or fragment/);
  for (const name of ['OLLAMA_TOKEN', 'ollama_api_key', 'VITE_OLLAMA_API_KEY', 'NEXT_PUBLIC_X_API_KEY'])
    fails({ ...model, credentialEnv: name }, /credentialEnv/);
  fails({ ...bare, provider: 'openai', endpoint }, /endpoint/);
  fails({ ...bare, provider: 'openai', credentialEnv }, /credentialEnv/);
  assert.equal(modelPricingEntrySchema.safeParse({ ...bare, provider: 'openai' }).success, true);
});
