import type { AppDetail } from '../api';

type Draft = AppDetail['draft'];
// oxlint-disable-next-line tulipfarm/product-copy -- Draft state identifiers, not user-facing copy.
type Built = Extract<Draft, { state: 'preview-ready' | 'live' }>;

/** Only file builds become the draft's preview, so a built head that isn't the preview is a server app's build. */
export const serverDraft = (draft: Draft): draft is Built =>
  // oxlint-disable-next-line tulipfarm/product-copy -- A draft state identifier, not user-facing copy.
  (draft.state === 'preview-ready' || draft.state === 'live') && draft.previewBuildId !== draft.buildId;
