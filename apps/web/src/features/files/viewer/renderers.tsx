import { lazy } from 'react';
import type { FileRenderers } from '@tulipfarm/sprout/file-viewer';
import { MessageResponse } from '@tulipfarm/sprout/message-response';
import OfficeFile from './office-file';

const SpreadsheetFile = lazy(() => import('./spreadsheet-file'));

/** Sprout's viewer offers only a download for sheets and Office files unless it is given these parsers. */
export const fileRenderers: FileRenderers = {
  markdown: ({ text }) => <MessageResponse>{text}</MessageResponse>,
  sheet: ({ bytes, onRetry }) => <SpreadsheetFile bytes={bytes} onRetry={onRetry} />,
  office: ({ name, bytes, kind, onRetry }) => <OfficeFile name={name} bytes={bytes} kind={kind} onRetry={onRetry} />,
};
