import type { AppId, AppReleaseId } from '@tulipfarm/apps';
import type { LiveAppRequest, RequestHandle } from '@tulipfarm/apps/store';

/** The app a visitor request is for. */
export type ServedApp = { readonly workspaceId: string; readonly appId: AppId };

/** Where the gateway records the visitor requests it is serving, so an app's server can read data during one. */
export type LiveRequestStore = {
  /** The release serving the app now when an admin has approved at least one of its data views, otherwise null. */
  readonly dataRelease: (app: ServedApp) => Promise<AppReleaseId | null>;
  readonly mint: (request: LiveAppRequest) => Promise<RequestHandle>;
  /** False once the request has expired or closed. */
  readonly renew: (handle: RequestHandle) => Promise<boolean>;
  readonly close: (handle: RequestHandle) => Promise<void>;
  readonly sweep: () => Promise<number>;
};

/** One visitor request's handle. `handle` settles before the request is relayed; null means relay without one. */
export type LiveRequest = { readonly handle: Promise<RequestHandle | null>; readonly close: () => void };

/**
 * Opens a live request for a visitor request: reads the serving release, mints a handle for it and renews it every
 * `renewMs` until `close` or until `gone` reports the visitor's connection has ended. A failure leaves the request
 * without a handle. A request closed or gone before the mint settles gets no handle, and the minted one is closed.
 */
export function openLiveRequest(
  store: LiveRequestStore,
  app: ServedApp,
  options: { readonly renewMs: number; readonly gone: () => boolean; readonly log: (error: unknown) => void },
): LiveRequest {
  let closed = false;
  let renewing: NodeJS.Timeout | undefined;
  const end = (handle: RequestHandle) => store.close(handle).catch(options.log);
  const handle = (async () => {
    const releaseId = await store.dataRelease(app);
    return releaseId && (await store.mint({ ...app, releaseId }));
  })().then(
    minted => {
      if (!minted) return null;
      if (closed || options.gone()) {
        closed = true;
        void end(minted);
        return null;
      }
      let pending = false;
      renewing = setInterval(() => {
        if (options.gone()) return live.close();
        if (pending) return;
        pending = true;
        store
          .renew(minted)
          .then(renewed => {
            if (!renewed) clearInterval(renewing);
          }, options.log)
          .finally(() => (pending = false));
      }, options.renewMs).unref();
      return minted;
    },
    error => {
      options.log(error);
      return null;
    },
  );
  const live: LiveRequest = {
    handle,
    close() {
      if (closed) return;
      closed = true;
      clearInterval(renewing);
      void handle.then(minted => minted && end(minted));
    },
  };
  return live;
}
