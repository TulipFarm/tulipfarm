const apiHealth = {
  type: 'object',
  additionalProperties: false,
  required: ['status'],
  properties: { status: { type: 'string', enum: ['ok'] } },
};

const dependencyHealth = {
  type: 'object',
  additionalProperties: false,
  required: ['status', 'latencyMs'],
  properties: {
    status: { type: 'string', enum: ['ok', 'unavailable'] },
    latencyMs: { type: 'integer', minimum: 0, description: 'Elapsed probe time in milliseconds' },
  },
};

const services = {
  type: 'object',
  additionalProperties: false,
  required: ['api', 'postgres', 'temporal', 'workers'],
  properties: {
    api: apiHealth,
    postgres: dependencyHealth,
    temporal: dependencyHealth,
    workers: dependencyHealth,
    temporalUi: dependencyHealth,
    publicWeb: dependencyHealth,
    storageMaintenance: dependencyHealth,
  },
};

const identity = { version: { type: 'string' }, commit: { type: 'string' } };

function healthResponse(status: 'ok' | 'degraded', description: string) {
  return {
    type: 'object',
    description,
    additionalProperties: false,
    required: ['status', 'services', 'version', 'commit'],
    properties: { status: { type: 'string', enum: [status] }, services, ...identity },
  };
}

export const rootSchema = {
  operationId: 'getApiIndex',
  tags: ['Health'],
  summary: 'Describe the API',
  description: 'Returns the service identity and links to the versioned documentation and health routes.',
  response: {
    200: {
      type: 'object',
      description: 'API index',
      additionalProperties: false,
      required: ['name', 'version', 'commit', 'docs', 'health'],
      properties: { name: { type: 'string' }, ...identity, docs: { type: 'string' }, health: { type: 'string' } },
    },
  },
};

export const livenessSchema = {
  operationId: 'getLivenessV1',
  tags: ['Health'],
  summary: 'Check API liveness',
  description: 'Returns immediately without contacting PostgreSQL, Temporal, or workers.',
  response: {
    200: {
      ...apiHealth,
      required: ['status', 'version', 'commit'],
      properties: { ...apiHealth.properties, ...identity },
      description: 'API is responding',
    },
  },
};

export const healthSchema = {
  operationId: 'getHealthV1',
  tags: ['Health'],
  summary: 'Check all backend services',
  description:
    'Checks PostgreSQL, the Temporal namespace, the Temporal UI unless `TEMPORAL_UI_URL` is empty, the public-web endpoint when `FIRECRAWL_ENDPOINT` is set, and a real workflow with an Activity. Public web reads credit usage when an API key is configured, otherwise probes /health; it does not scrape pages. Storage maintenance is checked only with isolated-v1 workspace storage. Each request creates a short workflow. Use on demand, not as a high-frequency liveness probe. Worker availability means the configured queue completed work, not that every replica is healthy. A failed probe can take about six seconds.',
  response: {
    200: healthResponse('ok', 'All service checks succeeded'),
    503: healthResponse('degraded', 'At least one service check failed or timed out'),
  },
};
