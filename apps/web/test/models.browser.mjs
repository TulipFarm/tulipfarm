import { registerModelsBrowserTests } from './models.fixture.mjs';

registerModelsBrowserTests({ shard: process.env.MODELS_SCENARIO ? undefined : [1, 2] });
