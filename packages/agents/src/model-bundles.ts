import type { Pool } from 'pg';
import { verifyServerModelBundle, type ModelBundle } from '@tulipfarm/config';

/**
 * Server model bundles in `model_lifecycle.bundles`. Each server registers its bundle at startup; runs record the
 * bundle id, and `read` returns an earlier bundle only when its stored content still hashes to that id.
 */
export function modelBundleStore(db: Pick<Pool, 'query'>) {
  const verified = new Map<string, ModelBundle>();
  return {
    async register(bundle: ModelBundle) {
      await db.query('SELECT app.register_model_bundle($1, $2::jsonb)', [bundle.id, JSON.stringify(bundle)]);
    },
    async read(bundleId: string): Promise<ModelBundle> {
      const known = verified.get(bundleId);
      if (known) return known;
      const stored: unknown = (await db.query('SELECT app.model_bundle($1) AS payload', [bundleId])).rows[0]?.payload;
      if (stored === null || stored === undefined) throw new Error('Model configuration changed');
      const bundle = verifyServerModelBundle(bundleId, stored);
      verified.set(bundleId, bundle);
      return bundle;
    },
  };
}
export type ModelBundleStore = ReturnType<typeof modelBundleStore>;
