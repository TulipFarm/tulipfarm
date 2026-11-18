import type { AppDetail } from '../api';

/** Only file builds become the draft's preview, so a built head that isn't the preview is a server app's build. */
export const serverDraft = (draft: AppDetail['draft']) =>
  // oxlint-disable-next-line tulipfarm/product-copy -- A draft state identifier, not user-facing copy.
  (draft.state === 'preview-ready' || draft.state === 'live') && draft.previewBuildId !== draft.buildId;
